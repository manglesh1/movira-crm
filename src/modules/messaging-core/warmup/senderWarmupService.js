const { Op } = require("sequelize");
const { getModels } = require("../../../db/models");
const domainSenderResolver = require("../providers/domainSenderResolver");

const STAGES = [
  { stage: 1, dailyLimit: 50, hourlyLimit: 10 },
  { stage: 2, dailyLimit: 100, hourlyLimit: 20 },
  { stage: 3, dailyLimit: 200, hourlyLimit: 40 },
  { stage: 4, dailyLimit: 400, hourlyLimit: 80 },
  { stage: 5, dailyLimit: 800, hourlyLimit: 160 },
  { stage: 6, dailyLimit: 1500, hourlyLimit: 300 },
  { stage: 7, dailyLimit: 2500, hourlyLimit: 500 },
  { stage: 8, dailyLimit: 4000, hourlyLimit: 800 },
  { stage: 9, dailyLimit: 6000, hourlyLimit: 1200 },
  { stage: 10, dailyLimit: 10000, hourlyLimit: 2000 },
];

const FINAL_STAGE = STAGES[STAGES.length - 1];

const EARLY_STAGE_ROLE_LOCAL_PARTS = new Set([
  "abuse",
  "admin",
  "billing",
  "contact",
  "help",
  "info",
  "noreply",
  "no-reply",
  "postmaster",
  "sales",
  "security",
  "support",
]);

class WarmupLimitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "WarmupLimitError";
    this.code = details.code || "WARMUP_LIMITED";
    this.statusCode = 429;
    this.details = details;
    this.retryAfterSeconds = details.retryAfterSeconds || 3600;
  }
}

async function ensureProfileForDomain(domain) {
  if (!domain || domain.status !== "verified") return null;
  const { CrmSenderWarmupProfile } = getModels();
  const [profile, created] = await CrmSenderWarmupProfile.findOrCreate({
    where: { domainId: domain.id },
    defaults: {
      locationId: domain.locationId,
      domainId: domain.id,
      provider: domain.provider,
      providerConfigId: domain.providerConfigId || null,
      status: "active",
      ...stageConfig(1),
      metadata: { createdFrom: "domain_verified", lastAdvancedDate: todayKey() },
    },
  });
  if (created) {
    await createWarmupEvent(profile, "started", {
      toStage: profile.stage,
      reason: "Domain verified; warmup started.",
    });
  }
  return profile;
}

async function reserveForMessage({ message, useCase, recipient }) {
  const sender = await domainSenderResolver.resolveSender({
    locationId: message.locationId,
    useCase,
  });
  if (!sender?.domainId) return { allowed: true, sender: null, profile: null };

  const { sequelize, CrmSenderWarmupProfile } = getModels();
  return sequelize.transaction(async (transaction) => {
    const sharedMoviraProfiles = sender.provider === "movira_ses"
      ? await CrmSenderWarmupProfile.findAll({
          where: { locationId: Number(message.locationId), provider: "movira_ses" },
          order: [["id", "ASC"]],
          transaction,
          lock: transaction.LOCK.UPDATE,
        })
      : null;
    const profile = sharedMoviraProfiles
      ? sharedMoviraProfiles.find((item) => String(item.domainId) === String(sender.domainId))
      : await CrmSenderWarmupProfile.findOne({
          where: { domainId: sender.domainId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
    if (!profile) {
      return { allowed: true, sender, profile: null };
    }

    const completedOnSharedMovira = profile.status === "completed" && sender.provider === "movira_ses";
    if (profile.status === "completed" && !completedOnSharedMovira) {
      return { allowed: true, sender, profile: null };
    }

    await resetDailyWindowIfNeeded(profile, { transaction });
    await resetHourlyWindowIfNeeded(profile, { transaction });

    if (completedOnSharedMovira) {
      for (const item of sharedMoviraProfiles) {
        if (String(item.id) === String(profile.id)) continue;
        await resetDailyWindowIfNeeded(item, { transaction });
        await resetHourlyWindowIfNeeded(item, { transaction });
      }
    }

    if (profile.status === "paused" || profile.status === "failed") {
      await createWarmupEvent(profile, "send_blocked", {
        reason: profile.pausedReason || "Warmup profile is paused.",
        transaction,
      });
      throw new WarmupLimitError(profile.pausedReason || "Sender warmup is paused.", {
        code: "WARMUP_PAUSED",
        senderDomainId: sender.domainId,
        warmupProfileId: profile.id,
        retryAfterSeconds: 3600,
      });
    }

    if (!completedOnSharedMovira && isRiskyRecipient(recipient) && profile.stage <= 3) {
      await createWarmupEvent(profile, "recipient_held", {
        reason: "Role-based recipient held during early warmup.",
        transaction,
      });
      throw new WarmupLimitError("Role-based recipients are held during early sender warmup.", {
        code: "WARMUP_RECIPIENT_HELD",
        senderDomainId: sender.domainId,
        warmupProfileId: profile.id,
        retryAfterSeconds: 86400,
      });
    }

    const quotaTodaySent = completedOnSharedMovira
      ? sharedMoviraProfiles.reduce((sum, item) => sum + Number(item.todaySent || 0), 0)
      : Number(profile.todaySent || 0);
    const quotaHourSent = completedOnSharedMovira
      ? sharedMoviraProfiles.reduce((sum, item) => sum + Number(item.currentHourSent || 0), 0)
      : Number(profile.currentHourSent || 0);
    const allowance = sharedMoviraAllowance(profile.locationId);
    const quotaDailyLimit = completedOnSharedMovira ? allowance.dailyLimit : Number(profile.dailyLimit || 0);
    const quotaHourlyLimit = completedOnSharedMovira ? allowance.hourlyLimit : Number(profile.hourlyLimit || 0);
    const dailyExceeded = quotaTodaySent >= quotaDailyLimit;
    const hourlyExceeded = quotaHourSent >= quotaHourlyLimit;
    if (hourlyExceeded) {
      await createWarmupEvent(profile, "quota_held", {
        reason: `${completedOnSharedMovira ? "Shared Movira" : "Hourly warmup"} quota reached: ${quotaHourSent}/${quotaHourlyLimit}.`,
        transaction,
      });
      throw new WarmupLimitError(
        completedOnSharedMovira
          ? "Shared Movira hourly sending allowance reached. Message will retry in the next hour."
          : "Hourly warmup quota reached. Message will retry in the next hour.", {
        code: completedOnSharedMovira ? "MOVIRA_SES_HOURLY_LIMIT" : "WARMUP_HOURLY_LIMIT",
        senderDomainId: sender.domainId,
        warmupProfileId: profile.id,
        retryAfterSeconds: secondsUntilNextHour(),
      });
    }
    if (dailyExceeded) {
      await createWarmupEvent(profile, "quota_held", {
        reason: `${completedOnSharedMovira ? "Shared Movira" : "Daily warmup"} quota reached: ${quotaTodaySent}/${quotaDailyLimit}.`,
        transaction,
      });
      throw new WarmupLimitError(
        completedOnSharedMovira
          ? "Shared Movira daily sending allowance reached. Connect a custom provider for higher volume or wait for the next daily window."
          : "Daily warmup quota reached. Message will retry in the next window.", {
        code: completedOnSharedMovira ? "MOVIRA_SES_DAILY_LIMIT" : "WARMUP_DAILY_LIMIT",
        senderDomainId: sender.domainId,
        warmupProfileId: profile.id,
        retryAfterSeconds: secondsUntilTomorrow(),
      });
    }

    await profile.increment("todaySent", { by: 1, transaction });
    await profile.increment("currentHourSent", { by: 1, transaction });
    await profile.reload({ transaction });
    return {
      allowed: true,
      sender,
      profile,
      warmup: {
        warmupProfileId: profile.id,
        senderDomainId: sender.domainId,
        stage: profile.stage,
        dailyLimit: quotaDailyLimit,
        todaySent: completedOnSharedMovira ? quotaTodaySent + 1 : profile.todaySent,
        mode: completedOnSharedMovira ? "shared_movira_allowance" : "warmup",
      },
    };
  });
}

async function recordMessageResult(message, eventType) {
  const profileId = message?.metadata?.warmup?.warmupProfileId || message?.payload?._warmup?.warmupProfileId;
  if (!profileId) return null;
  return recordProfileEvent(profileId, eventType);
}

async function recordProfileEvent(profileId, eventType) {
  const { CrmSenderWarmupProfile } = getModels();
  const profile = await CrmSenderWarmupProfile.findByPk(profileId);
  if (!profile) return null;
  await resetDailyWindowIfNeeded(profile);
  await resetHourlyWindowIfNeeded(profile);
  const field = metricField(eventType);
  if (field) await profile.increment(field, { by: 1 });
  await createWarmupEvent(profile, `metric_${eventType}`, {
    reason: `Recorded ${eventType}.`,
  });
  return profile.reload();
}

async function evaluateAll() {
  const { CrmSenderWarmupProfile } = getModels();
  const profiles = await CrmSenderWarmupProfile.findAll({
    where: { status: { [Op.in]: ["active", "paused"] } },
    order: [["createdAt", "ASC"]],
  });
  const results = [];
  for (const profile of profiles) {
    results.push(await evaluateProfile(profile));
  }
  return results;
}

async function evaluateProfile(profile) {
  const metrics = snapshot(profile);
  const health = evaluateHealth(metrics);
  const now = new Date();
  const shouldResetDailyWindowAfterEvaluation = String(profile.windowStartedAt) !== todayKey();

  async function finish(result) {
    if (shouldResetDailyWindowAfterEvaluation) {
      await resetDailyWindowIfNeeded(profile);
    }
    return result;
  }

  if (health.action === "pause") {
    await profile.update({
      status: "paused",
      pausedAt: now,
      pausedReason: health.reason,
      lastEvaluatedAt: now,
    });
    await createWarmupEvent(profile, "paused", { reason: health.reason });
    return finish({ profileId: profile.id, action: "paused", reason: health.reason });
  }

  if (profile.status === "paused") {
    await profile.update({ lastEvaluatedAt: now });
    return finish({ profileId: profile.id, action: "kept_paused", reason: profile.pausedReason });
  }

  const lastStageChangeDate = profile.metadata?.lastAdvancedDate || dateKey(profile.startedAt);
  if (lastStageChangeDate === todayKey()) {
    await profile.update({ lastEvaluatedAt: now });
    return finish({ profileId: profile.id, action: "already_advanced_today" });
  }

  if (health.action === "hold") {
    await profile.update({ lastEvaluatedAt: now });
    await createWarmupEvent(profile, "quota_held", { reason: health.reason });
    return finish({ profileId: profile.id, action: "held", reason: health.reason });
  }

  const next = nextStage(profile.stage);
  if (!next) {
    await profile.update({ status: "completed", completedAt: now, lastEvaluatedAt: now });
    await createWarmupEvent(profile, "completed", { reason: "Warmup reached final stage." });
    return finish({ profileId: profile.id, action: "completed" });
  }

  const fromStage = profile.stage;
  await profile.update({
    stage: next.stage,
    dailyLimit: next.dailyLimit,
    hourlyLimit: next.hourlyLimit,
    lastEvaluatedAt: now,
    metadata: {
      ...(profile.metadata || {}),
      lastAdvancedDate: todayKey(),
    },
  });
  await createWarmupEvent(profile, "quota_increased", {
    fromStage,
    toStage: next.stage,
    reason: "Warmup health is good.",
  });
  return finish({ profileId: profile.id, action: "advanced", fromStage, toStage: next.stage });
}

async function resetDailyWindowIfNeeded(profile, { transaction } = {}) {
  const today = todayKey();
  if (String(profile.windowStartedAt) === today) return profile;
  await profile.update({
    todaySent: 0,
    todayDelivered: 0,
    todayBounced: 0,
    todayComplaints: 0,
    todayUnsubscribed: 0,
    todayOpened: 0,
    todayClicked: 0,
    windowStartedAt: today,
  }, { transaction });
  await createWarmupEvent(profile, "daily_window_reset", {
    reason: "Warmup daily counters reset.",
    transaction,
  });
  return profile.reload({ transaction });
}

async function resetHourlyWindowIfNeeded(profile, { transaction } = {}) {
  const startedAt = profile.hourWindowStartedAt ? new Date(profile.hourWindowStartedAt).getTime() : 0;
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  if (startedAt >= oneHourAgo) return profile;
  await profile.update({
    currentHourSent: 0,
    hourWindowStartedAt: new Date(),
  }, { transaction });
  await createWarmupEvent(profile, "hourly_window_reset", {
    reason: "Warmup hourly counter reset.",
    transaction,
  });
  return profile.reload({ transaction });
}

async function createWarmupEvent(profile, eventType, options = {}) {
  const { CrmSenderWarmupEvent } = getModels();
  return CrmSenderWarmupEvent.create({
    warmupProfileId: profile.id,
    domainId: profile.domainId,
    eventType,
    fromStage: options.fromStage ?? null,
    toStage: options.toStage ?? null,
    reason: options.reason || null,
    metricsSnapshot: snapshot(profile),
  }, { transaction: options.transaction });
}

function evaluateHealth(metrics) {
  const sent = Math.max(1, Number(metrics.todaySent || 0));
  const bounceRate = Number(metrics.todayBounced || 0) / sent;
  const complaintRate = Number(metrics.todayComplaints || 0) / sent;
  const unsubscribeRate = Number(metrics.todayUnsubscribed || 0) / sent;

  if (metrics.todayComplaints > 0 && complaintRate > 0.001) {
    return { action: "pause", reason: `Complaint rate too high (${percent(complaintRate)}).` };
  }
  if (metrics.todayBounced >= 3 && bounceRate > 0.02) {
    return { action: "pause", reason: `Bounce rate too high (${percent(bounceRate)}).` };
  }
  if (metrics.todayUnsubscribed >= 5 && unsubscribeRate > 0.01) {
    return { action: "hold", reason: `Unsubscribe rate elevated (${percent(unsubscribeRate)}).` };
  }
  if (metrics.todaySent < Math.min(10, metrics.dailyLimit || 10)) {
    return { action: "hold", reason: "Not enough warmup volume to advance safely." };
  }
  return { action: "advance" };
}

function stageConfig(stage) {
  return STAGES.find((item) => item.stage === Number(stage)) || STAGES[0];
}

function nextStage(stage) {
  return STAGES.find((item) => item.stage === Number(stage) + 1) || null;
}

function metricField(eventType) {
  return {
    sent: null,
    delivered: "todayDelivered",
    delivery: "todayDelivered",
    bounce: "todayBounced",
    bounced: "todayBounced",
    complaint: "todayComplaints",
    complained: "todayComplaints",
    unsubscribe: "todayUnsubscribed",
    unsubscribed: "todayUnsubscribed",
    open: "todayOpened",
    opened: "todayOpened",
    click: "todayClicked",
    clicked: "todayClicked",
  }[String(eventType || "").toLowerCase()] || null;
}

function snapshot(profile) {
  return {
    status: profile.status,
    stage: profile.stage,
    dailyLimit: profile.dailyLimit,
    hourlyLimit: profile.hourlyLimit,
    todaySent: profile.todaySent,
    currentHourSent: profile.currentHourSent,
    todayDelivered: profile.todayDelivered,
    todayBounced: profile.todayBounced,
    todayComplaints: profile.todayComplaints,
    todayUnsubscribed: profile.todayUnsubscribed,
    todayOpened: profile.todayOpened,
    todayClicked: profile.todayClicked,
    windowStartedAt: profile.windowStartedAt,
  };
}

function isRiskyRecipient(email) {
  const local = String(email || "").split("@")[0]?.toLowerCase();
  return EARLY_STAGE_ROLE_LOCAL_PARTS.has(local);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function dateKey(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function getWarmupPlan() {
  return STAGES.map(({ stage, dailyLimit, hourlyLimit }) => ({
    stage,
    dailyLimit,
    hourlyLimit,
  }));
}

function sharedMoviraAllowance(locationId) {
  const fallback = { dailyLimit: FINAL_STAGE.dailyLimit, hourlyLimit: FINAL_STAGE.hourlyLimit };
  let configured = {};
  try {
    configured = JSON.parse(process.env.CRM_LOCATION_EMAIL_LIMITS || "{}");
  } catch (_error) {
    return fallback;
  }
  const selected = configured[String(locationId)] || configured.default || {};
  const dailyLimit = Math.min(10000000, Math.max(FINAL_STAGE.dailyLimit, Number(selected.dailyLimit) || fallback.dailyLimit));
  const hourlyLimit = Math.min(dailyLimit, Math.max(FINAL_STAGE.hourlyLimit, Number(selected.hourlyLimit) || fallback.hourlyLimit));
  return { dailyLimit, hourlyLimit };
}

function getPostWarmupPolicy(provider, locationId) {
  if (provider === "movira_ses") {
    const allowance = sharedMoviraAllowance(locationId);
    return {
      mode: "shared_movira_allowance",
      quotaScope: "location",
      dailyLimit: allowance.dailyLimit,
      hourlyLimit: allowance.hourlyLimit,
      customProviderRecommendedAboveDaily: allowance.dailyLimit,
    };
  }
  return {
    mode: "customer_provider_quota",
    quotaScope: "provider_account",
    dailyLimit: null,
    hourlyLimit: null,
    customProviderRecommendedAboveDaily: null,
  };
}

function secondsUntilTomorrow() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.ceil((tomorrow.getTime() - now.getTime()) / 1000));
}

function secondsUntilNextHour() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCMinutes(60, 0, 0);
  return Math.max(60, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

function percent(value) {
  return `${(Number(value || 0) * 100).toFixed(2)}%`;
}

module.exports = {
  STAGES,
  getWarmupPlan,
  getPostWarmupPolicy,
  sharedMoviraAllowance,
  WarmupLimitError,
  ensureProfileForDomain,
  evaluateAll,
  evaluateProfile,
  recordMessageResult,
  recordProfileEvent,
  reserveForMessage,
};
