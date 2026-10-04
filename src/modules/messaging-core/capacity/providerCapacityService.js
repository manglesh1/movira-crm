const { GetAccountCommand, SESv2Client } = require("@aws-sdk/client-sesv2");
const { Op } = require("sequelize");
const config = require("../../../config");
const { getModels } = require("../../../db/models");
const domainSenderResolver = require("../providers/domainSenderResolver");

const PROVIDER = "movira_ses";

class ProviderCapacityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProviderCapacityError";
    this.code = details.code || "PROVIDER_CAPACITY_HELD";
    this.statusCode = 429;
    this.retryAfterSeconds = details.retryAfterSeconds || 60;
    this.details = details;
  }
}

function settings() {
  const raw = config.aws.ses.capacity || {};
  return {
    enforcementEnabled: raw.enforcementEnabled === true,
    snapshotTtlSeconds: positiveNumber(raw.snapshotTtlSeconds, 60),
    reservationTtlSeconds: positiveNumber(raw.reservationTtlSeconds, 300),
    transactionalReservePercent: boundedPercent(raw.transactionalReservePercent, 20),
    safetyMarginPercent: boundedPercent(raw.safetyMarginPercent, 5),
  };
}

function scopeKey() {
  return `${PROVIDER}:${config.aws.ses.region}`;
}

async function fetchSesQuota() {
  const client = new SESv2Client({ region: config.aws.ses.region || config.aws.region });
  const response = await client.send(new GetAccountCommand({}));
  return normalizeQuota(response?.SendQuota);
}

function normalizeQuota(quota = {}) {
  const max24HourSend = finiteNonNegative(quota.Max24HourSend);
  const sentLast24Hours = finiteNonNegative(quota.SentLast24Hours);
  const maxSendRate = finiteNonNegative(quota.MaxSendRate);
  if (max24HourSend <= 0 || maxSendRate <= 0) {
    throw new ProviderCapacityError("Movira email capacity is temporarily unavailable.", {
      code: "PROVIDER_QUOTA_UNAVAILABLE",
      retryAfterSeconds: 60,
    });
  }
  return { max24HourSend, sentLast24Hours, maxSendRate, fetchedAt: new Date() };
}

function computeDecision(state, useCase, options = settings()) {
  const max24HourSend = finiteNonNegative(state.max24HourSend);
  const maxSendRate = finiteNonNegative(state.maxSendRate);
  const effectiveDailyLimit = Math.max(0, Math.floor(max24HourSend * (1 - options.safetyMarginPercent / 100)));
  const effectiveRateLimit = Math.max(0, Math.floor(maxSendRate * (1 - options.safetyMarginPercent / 100)));
  const used = finiteNonNegative(state.observedSentLast24Hours)
    + finiteNonNegative(state.unobservedAccepted)
    + finiteNonNegative(state.reservedTransactional)
    + finiteNonNegative(state.reservedMarketing);
  const marketingDailyLimit = Math.max(0, effectiveDailyLimit - Math.ceil(effectiveDailyLimit * options.transactionalReservePercent / 100));
  const marketingRateLimit = Math.max(0, effectiveRateLimit - Math.ceil(effectiveRateLimit * options.transactionalReservePercent / 100));
  const dailyLimit = useCase === "marketing" ? marketingDailyLimit : effectiveDailyLimit;
  const rateLimit = useCase === "marketing" ? marketingRateLimit : effectiveRateLimit;

  if (used >= dailyLimit) {
    return { allowed: false, reason: "daily", retryAfterSeconds: options.snapshotTtlSeconds, used, dailyLimit, rateLimit };
  }
  if (finiteNonNegative(state.rateWindowUsed) >= rateLimit) {
    return { allowed: false, reason: "rate", retryAfterSeconds: 1, used, dailyLimit, rateLimit };
  }
  return {
    allowed: true,
    used,
    dailyLimit,
    rateLimit,
    remaining: Math.max(0, dailyLimit - used - 1),
  };
}

async function reserveForMessage({ message, useCase, sender: suppliedSender, messageType }) {
  const options = settings();
  if (!options.enforcementEnabled || message?.channel !== "email") return { enforced: false, allowed: true };
  const sender = await resolveCapacitySender({ message, useCase, suppliedSender });
  if (sender?.provider !== PROVIDER) return { enforced: false, allowed: true, sender };

  const models = getModels();
  const key = scopeKey();
  const current = await models.CrmProviderCapacity.findOne({ where: { scopeKey: key } });
  let freshQuota = null;
  if (!current?.quotaFetchedAt || Date.now() - new Date(current.quotaFetchedAt).getTime() >= options.snapshotTtlSeconds * 1000) {
    freshQuota = await fetchSesQuota();
  }

  return models.sequelize.transaction(async (transaction) => {
    // One database-wide lock per provider account makes the first row creation and
    // every later reservation atomic across all API/worker processes.
    await models.sequelize.query("SELECT pg_advisory_xact_lock(hashtext(:scopeKey))", {
      replacements: { scopeKey: key },
      transaction,
    });
    let capacity = await models.CrmProviderCapacity.findOne({
      where: { scopeKey: key },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!capacity) {
      if (!freshQuota) freshQuota = await fetchSesQuota();
      capacity = await models.CrmProviderCapacity.create({
        scopeKey: key,
        provider: PROVIDER,
        region: config.aws.ses.region,
        max24HourSend: freshQuota.max24HourSend,
        maxSendRate: freshQuota.maxSendRate,
        observedSentLast24Hours: freshQuota.sentLast24Hours,
        quotaFetchedAt: freshQuota.fetchedAt,
      }, { transaction });
    } else if (freshQuota && (!capacity.quotaFetchedAt || new Date(freshQuota.fetchedAt) > new Date(capacity.quotaFetchedAt))) {
      // SES can report accepted sends with a short delay. Count only a bounded
      // recent window as potentially unobserved; never carry a synthetic count
      // forever when the rolling AWS 24-hour total naturally decreases.
      const recentAccepted = await models.CrmProviderCapacityReservation.count({
        where: {
          capacityId: capacity.id,
          status: "accepted",
          acceptedAt: { [Op.gte]: new Date(Date.now() - options.snapshotTtlSeconds * 2 * 1000) },
        },
        transaction,
      });
      await capacity.update({
        max24HourSend: freshQuota.max24HourSend,
        maxSendRate: freshQuota.maxSendRate,
        unobservedAccepted: recentAccepted,
        observedSentLast24Hours: freshQuota.sentLast24Hours,
        quotaFetchedAt: freshQuota.fetchedAt,
      }, { transaction });
    }

    await releaseExpired(capacity, models, transaction);
    await resetRateWindow(capacity, transaction);

    const resolvedMessageType = messageType || (useCase === "transactional" ? "transactional" : "marketing");
    const existing = await models.CrmProviderCapacityReservation.findOne({
      where: { capacityId: capacity.id, messageType: resolvedMessageType, messageId: message.id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (existing?.status === "accepted") {
      return { enforced: true, allowed: true, alreadyAccepted: true, reservation: existing, sender, providerResult: existing.metadata?.providerResult || null };
    }
    if (existing?.status === "pending" && new Date(existing.expiresAt) > new Date()) {
      return { enforced: true, allowed: true, reservation: existing, sender };
    }

    const decision = computeDecision(capacity, useCase, options);
    if (!decision.allowed) {
      const isMarketingReserve = useCase === "marketing" && decision.reason === "daily";
      throw new ProviderCapacityError(
        isMarketingReserve
          ? "Marketing is temporarily held to protect capacity for important transactional email."
          : "Email sending is temporarily held while provider capacity becomes available.",
        {
          code: isMarketingReserve ? "MARKETING_CAPACITY_RESERVED" : "PROVIDER_CAPACITY_HELD",
          retryAfterSeconds: decision.retryAfterSeconds,
          reason: decision.reason,
          remaining: 0,
        }
      );
    }

    const expiresAt = new Date(Date.now() + options.reservationTtlSeconds * 1000);
    let reservation = existing;
    if (reservation) {
      await reservation.update({ status: "pending", expiresAt, releasedAt: null, acceptedAt: null, metadata: {} }, { transaction });
    } else {
      reservation = await models.CrmProviderCapacityReservation.create({
        capacityId: capacity.id,
        messageType: resolvedMessageType,
        messageId: message.id,
        locationId: Number(message.locationId),
        useCase,
        status: "pending",
        expiresAt,
      }, { transaction });
    }
    const reservedField = useCase === "transactional" ? "reservedTransactional" : "reservedMarketing";
    await capacity.increment(reservedField, { by: 1, transaction });
    await capacity.increment("rateWindowUsed", { by: 1, transaction });
    return { enforced: true, allowed: true, reservation, sender, limits: decision };
  });
}

async function resolveCapacitySender({ message, useCase, suppliedSender }) {
  const sender = suppliedSender || await domainSenderResolver.resolveSender({ locationId: message.locationId, useCase });
  if (sender) return sender;
  const { CrmProviderConfig } = getModels();
  const provider = await CrmProviderConfig.findOne({
    where: {
      locationId: Number(message.locationId),
      channel: "email",
      isActive: true,
      domain: { [Op.in]: [useCase, "both"] },
    },
    order: [["priority", "ASC"], ["createdAt", "ASC"]],
  });
  return { provider: provider?.provider || PROVIDER, providerConfigId: provider?.id || null };
}

async function markAccepted(reservation, providerResult = {}) {
  if (!reservation?.id) return null;
  return finishReservation(reservation.id, "accepted", providerResult);
}

async function release(reservation, reason = "send_failed") {
  if (!reservation?.id) return null;
  return finishReservation(reservation.id, "released", { releaseReason: reason });
}

async function finishReservation(id, status, metadata) {
  const models = getModels();
  return models.sequelize.transaction(async (transaction) => {
    const reservation = await models.CrmProviderCapacityReservation.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!reservation || reservation.status !== "pending") return reservation;
    const capacity = await models.CrmProviderCapacity.findByPk(reservation.capacityId, { transaction, lock: transaction.LOCK.UPDATE });
    const field = reservation.useCase === "transactional" ? "reservedTransactional" : "reservedMarketing";
    await capacity.update({ [field]: Math.max(0, Number(capacity[field] || 0) - 1) }, { transaction });
    if (status === "accepted") await capacity.increment("unobservedAccepted", { by: 1, transaction });
    await reservation.update({
      status,
      acceptedAt: status === "accepted" ? new Date() : null,
      releasedAt: status === "released" ? new Date() : null,
      metadata: status === "accepted" ? { providerResult: safeProviderResult(metadata) } : metadata,
    }, { transaction });
    return reservation;
  });
}

async function releaseExpired(capacity, models, transaction) {
  const rows = await models.CrmProviderCapacityReservation.findAll({
    where: { capacityId: capacity.id, status: "pending", expiresAt: { [Op.lte]: new Date() } },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!rows.length) return;
  let transactional = 0;
  let marketing = 0;
  for (const row of rows) {
    if (row.useCase === "transactional") transactional += 1;
    else marketing += 1;
    await row.update({ status: "released", releasedAt: new Date(), metadata: { releaseReason: "reservation_expired" } }, { transaction });
  }
  await capacity.update({
    reservedTransactional: Math.max(0, Number(capacity.reservedTransactional || 0) - transactional),
    reservedMarketing: Math.max(0, Number(capacity.reservedMarketing || 0) - marketing),
  }, { transaction });
}

async function resetRateWindow(capacity, transaction) {
  const startedAt = new Date(capacity.rateWindowStartedAt).getTime();
  if (Date.now() - startedAt < 1000) return;
  await capacity.update({ rateWindowStartedAt: new Date(), rateWindowUsed: 0 }, { transaction });
}

function safeProviderResult(result = {}) {
  return {
    provider: result.provider || PROVIDER,
    providerMessageId: result.providerMessageId || null,
    providerConfigId: result.providerConfigId || null,
    senderDomainId: result.senderDomainId || null,
    senderDomain: result.senderDomain || null,
  };
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function boundedPercent(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(90, Math.max(0, number)) : fallback;
}

module.exports = {
  ProviderCapacityError,
  computeDecision,
  fetchSesQuota,
  markAccepted,
  normalizeQuota,
  release,
  reserveForMessage,
  settings,
};
