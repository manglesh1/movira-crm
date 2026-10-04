const { Op } = require("sequelize");
const { getModels } = require("../../../db/models");
const { PROVIDER_OPTIONS } = require("./providerCatalog");
const { verifyDomainRecords } = require("../../../shared/emailDnsVerifier");
const { UNVERIFIED_TTL_DAYS } = require("../../../workers/unverifiedDomainCleaner");
const emailProvider = require("../../messaging-core/providers/emailProviderRouter");
const providerDomain = require("./providerDomainService");
const warmupService = require("../../messaging-core/warmup/senderWarmupService");
const { decryptJsonIfNeeded } = require("../../../shared/credentialVault");
const config = require("../../../config");

const ROUTE_DEFINITIONS = [
  { routeKey: "calendar", label: "Calendar Domain" },
  { routeKey: "payments", label: "Payments" },
  { routeKey: "one_to_one", label: "One-to-one Conversation Domain" },
  { routeKey: "bulk_email", label: "Bulk Email Domain" },
  { routeKey: "campaign", label: "Campaign Domain" },
  { routeKey: "workflow", label: "Workflow Domain" },
  { routeKey: "default_dedicated", label: "Default Dedicated Domain" },
  { routeKey: "client_portal_notification", label: "Client portal notification domain" },
  { routeKey: "client_portal_otp", label: "Client portal OTP domain" },
];

async function getEmailSettings({ locationId }) {
  const {
    CrmProviderConfig,
    CrmEmailDomain,
    CrmEmailDomainRoute,
    CrmSenderWarmupProfile,
    CrmSenderWarmupEvent,
    TransactionalDeliveryEvent,
    TransactionalMessage,
    CrmMarketingDeliveryEvent,
    CrmMarketingMessage,
  } = getModels();
  const scopedWhere = locationId ? { locationId: Number(locationId) } : {};
  const providers = await CrmProviderConfig.findAll({
    where: {
      ...scopedWhere,
      channel: "email",
      isActive: true,
    },
    order: [["domain", "ASC"], ["priority", "ASC"], ["createdAt", "ASC"]],
  });
  const domains = locationId
    ? await CrmEmailDomain.findAll({
        where: { locationId: Number(locationId) },
        include: [warmupProfileInclude(CrmSenderWarmupProfile, CrmSenderWarmupEvent)],
        order: [["createdAt", "DESC"]],
      })
    : [];
  const routes = locationId
    ? await ensureDomainRoutes({
        model: CrmEmailDomainRoute,
        locationId: Number(locationId),
      })
    : [];

  const sharedMoviraUsage = getSharedMoviraUsage(domains);
  const providerHealth = new Map(await Promise.all(providers.map(async (provider) => [
    provider.id,
    await providerWebhookHealth(provider, {
      TransactionalDeliveryEvent,
      TransactionalMessage,
      CrmMarketingDeliveryEvent,
      CrmMarketingMessage,
    }),
  ])));
  return {
    setupSteps: [
      { key: "default_provider", label: "Use Movira SES", status: "ready" },
      { key: "sending_domain", label: "Add a dedicated sending domain", status: domains.length ? "started" : "not_started" },
      { key: "dns_verification", label: "Verify DNS records", status: domains.some((d) => d.status === "verified") ? "verified" : "pending" },
      { key: "optional_provider", label: "Connect customer SES, SendGrid, Mailgun, or Postmark", status: providers.length ? "configured" : "optional" },
    ],
    defaultProvider: PROVIDER_OPTIONS[0],
    providerOptions: PROVIDER_OPTIONS,
    providers: providers.map((provider) => serializeProvider(provider, { webhookHealth: providerHealth.get(provider.id) })),
    activeProviderRoutes: buildActiveProviderRoutes(providers),
    domains: domains.map((row) => serializeDomain(row, { sharedMoviraUsage })),
    routes: routes.map(serializeRoute),
  };
}

async function providerWebhookHealth(provider, models) {
  const providerKey = ({
    customer_ses: "ses",
    customer_sendgrid: "sendgrid",
    customer_mailgun: "mailgun",
    customer_postmark: "postmark",
  })[provider.provider] || provider.provider;
  const locationWhere = provider.locationId ? { locationId: Number(provider.locationId) } : {};
  const [transactional, marketing] = await Promise.all([
    models.TransactionalDeliveryEvent.findOne({
      where: { provider: providerKey },
      include: [{ model: models.TransactionalMessage, as: "message", required: true, where: locationWhere, attributes: [] }],
      order: [["occurredAt", "DESC"]],
    }),
    models.CrmMarketingDeliveryEvent.findOne({
      where: { provider: providerKey },
      include: [{ model: models.CrmMarketingMessage, as: "message", required: true, where: locationWhere, attributes: [] }],
      order: [["occurredAt", "DESC"]],
    }),
  ]);
  const latest = [transactional, marketing]
    .filter(Boolean)
    .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))[0] || null;
  const guardConfigured = providerWebhookGuardConfigured(providerKey);
  return {
    status: latest ? "event_observed" : guardConfigured ? "awaiting_event" : "configuration_required",
    signatureGuardConfigured: guardConfigured,
    lastEventAt: latest?.occurredAt || null,
    lastEventType: latest?.eventType || null,
    note: latest
      ? "A signed provider delivery event has been matched to this location."
      : guardConfigured
        ? "Webhook authentication is configured; send a test email and wait for its provider event."
        : "Configure the production webhook authentication secret/key before sending.",
  };
}

function providerWebhookGuardConfigured(providerKey) {
  if (providerKey === "ses") return true;
  if (providerKey === "sendgrid") return Boolean(config.webhooks.sendgridPublicKey);
  if (providerKey === "mailgun") return Boolean(config.webhooks.mailgunSigningKey);
  if (providerKey === "postmark") {
    return Boolean(config.webhooks.postmarkToken || (config.webhooks.postmarkUsername && config.webhooks.postmarkPassword));
  }
  return false;
}

function buildActiveProviderRoutes(providers = []) {
  return ["transactional", "marketing"].map((useCase) => {
    const provider = providers.find((row) => row.domain === useCase || row.domain === "both");
    return {
      useCase,
      provider: provider ? serializeProvider(provider) : null,
      isDefault: !provider,
      displayName: provider?.displayName || "Movira Email System",
      providerKey: provider?.provider || "movira_ses",
      note: provider
        ? "Customer provider overrides Movira SES for this use case."
        : "Movira SES is used because no active customer provider overrides this use case.",
    };
  });
}

async function ensureDomainRoutes({ model, locationId }) {
  const rows = await model.findAll({
    where: { locationId },
    order: [["label", "ASC"]],
  });
  const byKey = new Map(rows.map((row) => [row.routeKey, row]));
  const missing = ROUTE_DEFINITIONS.filter((item) => !byKey.has(item.routeKey));
  for (const item of missing) {
    const created = await model.create({
      locationId,
      routeKey: item.routeKey,
      label: item.label,
      domainId: null,
      trafficPercent: 100,
      frequencyPolicy: {},
    });
    rows.push(created);
  }
  return rows.sort((a, b) => {
    const ai = ROUTE_DEFINITIONS.findIndex((item) => item.routeKey === a.routeKey);
    const bi = ROUTE_DEFINITIONS.findIndex((item) => item.routeKey === b.routeKey);
    return ai - bi;
  });
}

async function createDomain(body = {}) {
  const { CrmEmailDomain, CrmProviderConfig } = getModels();
  const domain = normalizeDomain(body.domain);
  const errors = validateDomainBody({ ...body, domain });
  if (errors.length) throwValidation(errors);

  const dup = await CrmEmailDomain.findOne({
    where: { locationId: Number(body.locationId), domain },
  });
  if (dup) {
    const err = new Error("This domain is already configured for the venue");
    err.statusCode = 409;
    throw err;
  }

  const provider = String(body.provider || "movira_ses").trim();
  const providerConfigId = body.providerConfigId || null;
  const providerConfig = await resolveProviderConfig({
    model: CrmProviderConfig,
    locationId: Number(body.locationId),
    provider,
    providerConfigId,
    useCase: body.useCase || "marketing",
  });

  let identity;
  try {
    identity = await providerDomain.createDomainIdentity({ provider, providerConfig, domain });
  } catch (err) {
    const deniedAction = String(err?.message || "").match(
      /not authorized to perform:\s*(ses:[A-Za-z0-9]+)/i
    )?.[1];
    const isSesPermissionDenied =
      provider === "movira_ses" &&
      (deniedAction || err?.name === "AccessDeniedException" || err?.name === "AccessDenied");
    const message = isSesPermissionDenied
      ? `Movira SES domain provisioning is unavailable because the service role is missing ${deniedAction || "a required SES permission"}.`
      : `Domain setup failed: ${err?.message || "unknown error"}`;
    const wrapped = new Error(message);
    wrapped.statusCode = isSesPermissionDenied ? 503 : (err?.statusCode || 502);
    wrapped.code = isSesPermissionDenied
      ? "SES_DOMAIN_PROVISIONING_PERMISSION_DENIED"
      : (err?.code || "DOMAIN_SETUP_FAILED");
    wrapped.details = isSesPermissionDenied ? err?.message : undefined;
    wrapped.requiredActions = isSesPermissionDenied
      ? [
          "ses:CreateEmailIdentity",
          "ses:GetEmailIdentity",
          "ses:PutEmailIdentityMailFromAttributes",
          "ses:DeleteEmailIdentity",
        ]
      : undefined;
    wrapped.errors = isSesPermissionDenied
      ? [{ field: "provider", message }]
      : (err?.errors || []);
    throw wrapped;
  }

  const row = await CrmEmailDomain.create({
    locationId: Number(body.locationId),
    domain,
    domainType: body.domainType || "subdomain",
    useCase: body.useCase || "marketing",
    provider,
    providerConfigId: providerConfig?.id || null,
    status: "pending_dns",
    dnsRecords: identity.dnsRecords,
    senderName: body.senderName || null,
    senderEmail: body.senderEmail || null,
    providerIdentityName: identity.providerIdentityName || domain,
    providerIdentityArn: identity.providerIdentityArn || null,
    mailFromDomain: identity.mailFromDomain || null,
    lastVerificationError: null,
    isDefault: false,
    isActive: true,
  });

  return serializeDomain(row);
}

async function listDomains({ locationId } = {}) {
  const { CrmEmailDomain, CrmSenderWarmupProfile, CrmSenderWarmupEvent } = getModels();
  if (!locationId) {
    const err = new Error("locationId is required");
    err.statusCode = 400;
    throw err;
  }
  const rows = await CrmEmailDomain.findAll({
    where: { locationId: Number(locationId) },
    include: [warmupProfileInclude(CrmSenderWarmupProfile, CrmSenderWarmupEvent)],
    order: [["isDefault", "DESC"], ["createdAt", "DESC"]],
  });
  const sharedMoviraUsage = getSharedMoviraUsage(rows);
  return rows.map((row) => serializeDomain(row, { sharedMoviraUsage }));
}

async function getDomain(id, { locationId } = {}) {
  const { CrmEmailDomain, CrmSenderWarmupProfile, CrmSenderWarmupEvent } = getModels();
  const row = await CrmEmailDomain.findByPk(id, {
    include: [warmupProfileInclude(CrmSenderWarmupProfile, CrmSenderWarmupEvent)],
  });
  if (!row) {
    const err = new Error("Domain not found");
    err.statusCode = 404;
    throw err;
  }
  assertLocationOwnership(row, locationId, "Domain");
  const locationDomains = await CrmEmailDomain.findAll({
    where: { locationId: row.locationId },
    include: [warmupProfileInclude(CrmSenderWarmupProfile, CrmSenderWarmupEvent)],
  });
  return serializeDomain(row, { sharedMoviraUsage: getSharedMoviraUsage(locationDomains) });
}

async function deleteDomain(id, { locationId } = {}) {
  const { CrmEmailDomain, CrmEmailDomainRoute, CrmProviderConfig } = getModels();
  const row = await CrmEmailDomain.findByPk(id);
  if (!row) {
    const err = new Error("Domain not found");
    err.statusCode = 404;
    throw err;
  }
  assertLocationOwnership(row, locationId, "Domain");
  // Detach this domain from any routes that reference it, then hard-delete
  // so the same domain string can be re-added without a 409 conflict.
  await CrmEmailDomainRoute.update(
    { domainId: null },
    { where: { domainId: row.id } }
  );
  try {
    const providerConfig = row.providerConfigId ? await CrmProviderConfig.findByPk(row.providerConfigId) : null;
    await providerDomain.deleteDomainIdentity({
      provider: row.provider,
      providerConfig,
      domain: row.domain,
      identityName: row.providerIdentityName,
    });
  } catch (err) {
    row.lastVerificationError = `SES identity delete failed: ${err?.message || "unknown error"}`;
    await row.save();
  }
  await row.destroy();
  return true;
}

async function setDefaultDomain(id, { locationId } = {}) {
  const { CrmEmailDomain } = getModels();
  const row = await CrmEmailDomain.findByPk(id);
  if (!row) {
    const err = new Error("Domain not found");
    err.statusCode = 404;
    throw err;
  }
  assertLocationOwnership(row, locationId, "Domain");
  if (row.status !== "verified") {
    throwValidation([{ field: "domainId", message: "Verify this domain before setting it as default." }]);
  }
  await CrmEmailDomain.update(
    { isDefault: false },
    { where: { locationId: row.locationId, id: { [Op.ne]: row.id } } }
  );
  await row.update({ isDefault: true });
  return serializeDomain(row);
}

async function listDomainRoutes({ locationId } = {}) {
  const { CrmEmailDomainRoute } = getModels();
  if (!locationId) {
    const err = new Error("locationId is required");
    err.statusCode = 400;
    throw err;
  }
  const rows = await ensureDomainRoutes({
    model: CrmEmailDomainRoute,
    locationId: Number(locationId),
  });
  return rows.map(serializeRoute);
}

async function verifyDomain(id, { locationId } = {}) {
  const { CrmEmailDomain, CrmProviderConfig, CrmSenderWarmupProfile, CrmSenderWarmupEvent, CrmAuditLog } = getModels();
  const row = await CrmEmailDomain.findByPk(id);
  if (!row) {
    const err = new Error("Domain not found");
    err.statusCode = 404;
    throw err;
  }
  assertLocationOwnership(row, locationId, "Domain");
  const providerConfig = row.providerConfigId ? await CrmProviderConfig.findByPk(row.providerConfigId) : null;
  let identity;
  try {
    identity = await providerDomain.refreshDomainIdentity({
      provider: row.provider,
      providerConfig,
      domain: row.domain,
      identityName: row.providerIdentityName,
    });
  } catch (err) {
    const message = `Domain verification lookup failed: ${err?.message || "unknown error"}`;
    await row.update({
      lastDnsCheckedAt: new Date(),
      lastVerificationError: message,
    });
    const wrapped = new Error(message);
    wrapped.statusCode = err?.statusCode || 502;
    throw wrapped;
  }

  const seedRecords = identity.dnsRecords || [];
  let dnsResult;
  try {
    dnsResult = await verifyDomainRecords(seedRecords, row.domain);
  } catch (err) {
    const message = `DNS lookup failed: ${err?.message || "unknown error"}`;
    await row.update({
      lastDnsCheckedAt: new Date(),
      lastVerificationError: message,
    });
    const wrapped = new Error(message);
    wrapped.statusCode = err?.statusCode || 502;
    throw wrapped;
  }
  const { records: checked, allOk } = dnsResult;
  const providerOk = Boolean(identity.providerVerified);
  const newStatus = allOk && providerOk ? "verified" : "verification_requested";
  const previousStatus = row.status;
  const verificationMessage = !allOk
    ? "One or more DNS records are still pending."
    : !providerOk
      ? "All DNS records are live. Waiting for the email provider to confirm the sending identity."
      : null;
  await row.update({
    status: newStatus,
    verifiedAt: newStatus === "verified" ? new Date() : null,
    dnsRecords: checked,
    providerIdentityName: identity?.providerIdentityName || row.providerIdentityName || row.domain,
    providerIdentityArn: identity?.providerIdentityArn || row.providerIdentityArn || null,
    mailFromDomain: identity?.mailFromDomain || row.mailFromDomain || null,
    lastDnsCheckedAt: new Date(),
    lastVerificationError: verificationMessage,
  });
  if (newStatus === "verified") {
    await warmupService.ensureProfileForDomain(await CrmEmailDomain.findByPk(row.id));
  }
  if (newStatus !== previousStatus && (newStatus === "verified" || previousStatus === "verified")) {
    try {
      await CrmAuditLog.create({
        locationId: row.locationId,
        action: newStatus === "verified" ? "email_domain_verified" : "email_domain_verification_lost",
        entityType: "system",
        entityId: String(row.id),
        entityName: row.domain,
        outcome: newStatus === "verified" ? "success" : "warning",
        metadata: {
          previousStatus,
          status: newStatus,
          message: verificationMessage,
          customerVisible: true,
        },
      });
    } catch (_auditError) {
      // Verification must remain authoritative even if the audit store is temporarily unavailable.
    }
  }
  const fresh = await CrmEmailDomain.findByPk(row.id, {
    include: [warmupProfileInclude(CrmSenderWarmupProfile, CrmSenderWarmupEvent)],
  });
  return serializeDomain(fresh || row);
}

function warmupProfileInclude(CrmSenderWarmupProfile, CrmSenderWarmupEvent) {
  return {
    model: CrmSenderWarmupProfile,
    as: "warmupProfile",
    required: false,
    include: [{
      model: CrmSenderWarmupEvent,
      as: "events",
      required: false,
      separate: true,
      limit: 30,
      order: [["createdAt", "DESC"]],
    }],
  };
}

async function updateWarmupControl(domainId, body = {}, { locationId } = {}) {
  const { CrmEmailDomain, CrmSenderWarmupProfile, CrmSenderWarmupEvent } = getModels();
  const domain = await CrmEmailDomain.findByPk(domainId);
  if (!domain) {
    const err = new Error("Domain not found");
    err.statusCode = 404;
    throw err;
  }
  assertLocationOwnership(domain, locationId, "Domain");
  const profile = await CrmSenderWarmupProfile.findOne({ where: { domainId: domain.id } });
  if (!profile) {
    const err = new Error("Warmup has not started for this domain.");
    err.statusCode = 409;
    throw err;
  }
  const action = String(body.action || "").trim().toLowerCase();
  if (!['pause', 'resume'].includes(action)) {
    throwValidation([{ field: "action", message: "Choose pause or resume." }]);
  }
  if (profile.status === "completed") {
    const err = new Error("Completed warmup does not need a manual override.");
    err.statusCode = 409;
    throw err;
  }

  const reason = String(body.reason || "").trim();
  if (action === "pause" && reason.length < 3) {
    throwValidation([{ field: "reason", message: "Add a short reason for the manual pause." }]);
  }
  await profile.update(action === "pause"
    ? { status: "paused", pausedAt: new Date(), pausedReason: reason }
    : { status: "active", pausedAt: null, pausedReason: null, lastEvaluatedAt: new Date() });
  await CrmSenderWarmupEvent.create({
    warmupProfileId: profile.id,
    domainId: domain.id,
    eventType: action === "pause" ? "manual_pause" : "manual_resume",
    fromStage: profile.stage,
    toStage: profile.stage,
    reason: reason || "Warmup resumed by an administrator.",
    metricsSnapshot: {
      status: profile.status,
      stage: profile.stage,
      dailyLimit: profile.dailyLimit,
      hourlyLimit: profile.hourlyLimit,
      todaySent: profile.todaySent,
      todayBounced: profile.todayBounced,
      todayComplaints: profile.todayComplaints,
    },
  });
  return getDomain(domain.id);
}

function isHealthCheckDue(lastCheckedAt, maxAgeMinutes, now = new Date()) {
  if (!lastCheckedAt) return true;
  const checkedAt = new Date(lastCheckedAt).getTime();
  if (!Number.isFinite(checkedAt)) return true;
  return now.getTime() - checkedAt >= Math.max(1, Number(maxAgeMinutes) || 1) * 60 * 1000;
}

function domainHealthCheckIntervalMinutes(row) {
  return row?.status === "verified"
    ? Number(process.env.EMAIL_VERIFIED_DOMAIN_RECHECK_MINUTES || 1440)
    : Number(process.env.EMAIL_PENDING_DOMAIN_RECHECK_MINUTES || 60);
}

async function checkProviderHealth(providerOrId) {
  const { CrmProviderConfig } = getModels();
  const row = typeof providerOrId === "object" && providerOrId
    ? providerOrId
    : await CrmProviderConfig.findByPk(providerOrId);
  if (!row) {
    const err = new Error("Provider not found");
    err.statusCode = 404;
    throw err;
  }

  const checkedAt = new Date();
  try {
    const result = await verifyProviderConfig({
      provider: row.provider,
      config: decryptJsonIfNeeded(row.encryptedConfig),
    });
    await row.update({
      lastTestedAt: checkedAt,
      lastTestError: result.ok ? null : result.message,
      verifiedAt: result.ok ? (row.verifiedAt || checkedAt) : row.verifiedAt,
    });
    return {
      id: row.id,
      provider: row.provider,
      ok: Boolean(result.ok),
      message: result.message,
      checkedAt,
    };
  } catch (err) {
    const message = err?.message || "Provider health check failed.";
    await row.update({ lastTestedAt: checkedAt, lastTestError: message });
    return { id: row.id, provider: row.provider, ok: false, message, checkedAt };
  }
}

async function evaluateEmailInfrastructureHealth({
  now = new Date(),
  providerLimit = 100,
  domainLimit = 100,
} = {}) {
  const { CrmProviderConfig, CrmEmailDomain } = getModels();
  const providerRows = await CrmProviderConfig.findAll({
    where: { channel: "email", isActive: true },
    order: [["lastTestedAt", "ASC NULLS FIRST"], ["createdAt", "ASC"]],
    limit: Math.max(1, Number(providerLimit) || 100),
  });
  const providerMaxAge = Number(process.env.EMAIL_PROVIDER_RECHECK_MINUTES || 1440);
  const dueProviders = providerRows.filter((row) =>
    isHealthCheckDue(row.lastTestedAt, providerMaxAge, now)
  );

  const domainRows = await CrmEmailDomain.findAll({
    where: { isActive: true },
    order: [["lastDnsCheckedAt", "ASC NULLS FIRST"], ["createdAt", "ASC"]],
    limit: Math.max(1, Number(domainLimit) || 100),
  });
  const dueDomains = domainRows.filter((row) =>
    isHealthCheckDue(row.lastDnsCheckedAt, domainHealthCheckIntervalMinutes(row), now)
  );

  const providers = [];
  for (const row of dueProviders) providers.push(await checkProviderHealth(row));

  const domains = [];
  for (const row of dueDomains) {
    try {
      const result = await verifyDomain(row.id);
      domains.push({
        id: row.id,
        domain: row.domain,
        ok: result.status === "verified",
        status: result.status,
        message: result.lastVerificationError || null,
      });
    } catch (err) {
      domains.push({
        id: row.id,
        domain: row.domain,
        ok: false,
        status: row.status,
        message: err?.message || "Domain health check failed.",
      });
    }
  }

  return { providers, domains };
}

// Verify customer-supplied credentials BEFORE saving the provider row.
// Each provider type uses its own protocol-level handshake — no row is
// touched, so the user can iterate on credentials in the modal until
// the check passes, then click Save with confidence.
async function verifyProviderConfig({ provider, config = {} } = {}) {
  const option = PROVIDER_OPTIONS.find((o) => o.provider === provider);
  if (!option) throwValidation([{ field: "provider", message: "Unknown provider" }]);
  if (!option.requiresCustomerCredentials) {
    return { ok: true, message: "Movira default — no customer credentials to verify." };
  }

  // Make sure all declared fields are populated before we hit the network.
  const missing = (option.fields || []).filter((f) => !String(config[f] || "").trim());
  if (missing.length) {
    throwValidation(
      missing.map((f) => ({
        field: `config.${f}`,
        message: `${humanizeFieldKey(f)} is required.`,
      }))
    );
  }

  if (provider === "customer_ses") {
    return verifyCustomerSes(config);
  }
  if (provider === "customer_sendgrid") {
    return verifySendgrid(config);
  }
  if (provider === "customer_mailgun") {
    return verifyMailgun(config);
  }
  if (provider === "customer_postmark") {
    return verifyPostmark(config);
  }
  return { ok: false, message: "Verification not implemented for this provider." };
}

async function verifyCustomerSes(config) {
  validateAwsRegion(config.region, "SES region");
  let SESv2Client;
  let GetAccountCommand;
  try {
    ({ SESv2Client, GetAccountCommand } = require("@aws-sdk/client-sesv2"));
  } catch (_e) {
    return { ok: false, message: "AWS SES SDK is not installed." };
  }
  try {
    const client = new SESv2Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    const out = await client.send(new GetAccountCommand({}));
    if (out?.SendingEnabled === false) {
      return {
        ok: false,
        message: "Credentials are valid, but SES sending is disabled on this account (sandbox or suspended).",
      };
    }
    return { ok: true, message: `SES account reachable in ${config.region}.` };
  } catch (err) {
    return { ok: false, message: `SES verify failed: ${err?.name || ""} ${err?.message || ""}`.trim() };
  }
}

async function verifySendgrid(config) {
  if (typeof fetch !== "function") {
    return { ok: false, message: "SendGrid verify needs Node 18+ (built-in fetch)." };
  }
  try {
    const res = await fetch("https://api.sendgrid.com/v3/user/credits", {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: "API key rejected by SendGrid." };
    }
    if (!res.ok) {
      return { ok: false, message: `SendGrid returned ${res.status} ${res.statusText}` };
    }
    return { ok: true, message: "SendGrid API key accepted." };
  } catch (err) {
    return { ok: false, message: `SendGrid verify failed: ${err?.message || "network error"}` };
  }
}

async function verifyMailgun(config) {
  if (typeof fetch !== "function") {
    return { ok: false, message: "Mailgun verify needs Node 18+ (built-in fetch)." };
  }
  try {
    const res = await fetch(`${mailgunApiBase(config.region)}/v3/domains/${encodeURIComponent(config.domain)}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`api:${config.apiKey}`).toString("base64")}`,
      },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: "API key rejected by Mailgun." };
    }
    if (res.status === 404) {
      return { ok: false, message: "Mailgun domain was not found for this API key." };
    }
    if (!res.ok) {
      return { ok: false, message: `Mailgun returned ${res.status} ${res.statusText}` };
    }
    return { ok: true, message: `Mailgun domain ${config.domain} is reachable.` };
  } catch (err) {
    return { ok: false, message: `Mailgun verify failed: ${err?.message || "network error"}` };
  }
}

async function verifyPostmark(config) {
  if (typeof fetch !== "function") {
    return { ok: false, message: "Postmark verify needs Node 18+ (built-in fetch)." };
  }
  try {
    const res = await fetch("https://api.postmarkapp.com/server", {
      headers: {
        Accept: "application/json",
        "X-Postmark-Server-Token": config.serverToken,
      },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: "Server token rejected by Postmark." };
    }
    if (!res.ok) {
      return { ok: false, message: `Postmark returned ${res.status} ${res.statusText}` };
    }
    return { ok: true, message: "Postmark server token accepted." };
  } catch (err) {
    return { ok: false, message: `Postmark verify failed: ${err?.message || "network error"}` };
  }
}

function mailgunApiBase(region) {
  return String(region || "us").toLowerCase() === "eu"
    ? "https://api.eu.mailgun.net"
    : "https://api.mailgun.net";
}

function validateAwsRegion(region, label = "AWS region") {
  const value = String(region || "").trim();
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(value)) {
    throwValidation([{ field: "config.region", message: `${label} must be a valid AWS region like us-east-1 or ca-central-1.` }]);
  }
  return value;
}

function humanizeFieldKey(key) {
  return String(key)
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

async function testProvider(id, body = {}, { locationId } = {}) {
  const { CrmProviderConfig } = getModels();
  const row = await CrmProviderConfig.findByPk(id);
  if (!row) {
    const err = new Error("Provider not found");
    err.statusCode = 404;
    throw err;
  }
  assertLocationOwnership(row, locationId, "Provider");
  if (!isEmail(body.to)) {
    await row.update({
      lastTestedAt: new Date(),
      lastTestError: "A valid test recipient is required before sending a live test.",
    });
    return serializeProvider(row);
  }

  try {
    await emailProvider.sendWithProviderRow(
      row,
      {
        locationId: row.locationId,
        to: String(body.to).trim(),
        subject: body.subject || `Movira provider test: ${row.displayName}`,
        html:
          body.html ||
          `<p>This is a Movira CRM test email for <strong>${row.displayName}</strong>.</p>`,
        text: body.text || `This is a Movira CRM test email for ${row.displayName}.`,
      },
      row.domain === "marketing" ? "marketing" : "transactional"
    );
    await row.update({ lastTestedAt: new Date(), lastTestError: null });
  } catch (err) {
    await row.update({
      lastTestedAt: new Date(),
      lastTestError: err?.message || "Provider test failed.",
    });
  }
  return serializeProvider(await CrmProviderConfig.findByPk(id));
}

async function deleteProvider(id, { locationId } = {}) {
  const { CrmProviderConfig } = getModels();
  const row = await CrmProviderConfig.findByPk(id);
  if (!row) return false;
  assertLocationOwnership(row, locationId, "Provider");
  await row.update({ isActive: false });
  return true;
}

async function updateDomainRoute(id, body = {}, { locationId } = {}) {
  const { CrmEmailDomainRoute, CrmEmailDomain } = getModels();
  const row = await CrmEmailDomainRoute.findByPk(id);
  if (!row) {
    const err = new Error("Domain route not found");
    err.statusCode = 404;
    throw err;
  }
  assertLocationOwnership(row, locationId, "Domain route");

  if (body.domainId) {
    const domain = await CrmEmailDomain.findByPk(body.domainId);
    if (!domain || Number(domain.locationId) !== Number(row.locationId)) {
      throwValidation([{ field: "domainId", message: "Choose a valid domain for this location." }]);
    }
    if (domain.status !== "verified") {
      throwValidation([{ field: "domainId", message: "Only verified domains can be used for routing." }]);
    }
  }

  const trafficPercent = Number(body.trafficPercent ?? row.trafficPercent);
  if (!Number.isInteger(trafficPercent) || trafficPercent < 0 || trafficPercent > 100) {
    throwValidation([{ field: "trafficPercent", message: "Traffic percentage must be between 0 and 100." }]);
  }

  await row.update({
    domainId: body.domainId || null,
    trafficPercent,
    frequencyPolicy: body.frequencyPolicy || row.frequencyPolicy || {},
  });
  return serializeRoute(row);
}

async function createProvider(body = {}) {
  const { CrmProviderConfig } = getModels();
  const provider = String(body.provider || "").trim();
  const option = PROVIDER_OPTIONS.find((item) => item.provider === provider);
  const errors = validateProviderBody(body, option);
  if (errors.length) throwValidation(errors);

  const verification = await verifyProviderConfig({ provider, config: body.config || {} });
  if (!verification.ok) {
    const err = new Error(verification.message || "Provider credentials could not be verified.");
    err.statusCode = 422;
    err.code = "PROVIDER_CREDENTIAL_VERIFICATION_FAILED";
    throw err;
  }

  const row = await CrmProviderConfig.create({
    locationId: body.locationId ? Number(body.locationId) : null,
    domain: body.domain || "marketing",
    channel: "email",
    provider,
    displayName: body.displayName || option.label,
    priority: Number(body.priority || 100),
    isDefault: Boolean(body.isDefault),
    isActive: true,
    encryptedConfig: sanitizeConfig(body.config || {}, option.fields),
    verifiedAt: new Date(),
    lastTestedAt: new Date(),
    lastTestError: null,
  });

  return serializeProvider(row);
}

function assertLocationOwnership(row, locationId, label = "Resource") {
  if (locationId === undefined || locationId === null || locationId === "") return row;
  if (Number(row.locationId) === Number(locationId)) return row;
  const err = new Error(`${label} not found`);
  err.statusCode = 404;
  err.code = "LOCATION_RESOURCE_NOT_FOUND";
  throw err;
}

function sanitizeConfig(config, allowedFields) {
  const out = {};
  for (const key of allowedFields || []) {
    if (config[key] !== undefined) out[key] = config[key];
  }
  return out;
}

function maskConfig(config = {}) {
  const masked = {};
  for (const [key, value] of Object.entries(config || {})) {
    if (/password|secret|key|token/i.test(key)) {
      masked[key] = value ? "********" : "";
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

function serializeProvider(row, { webhookHealth = null } = {}) {
  const option = PROVIDER_OPTIONS.find((item) => item.provider === row.provider);
  return {
    id: row.id,
    locationId: row.locationId,
    domain: row.domain,
    channel: row.channel,
    provider: row.provider,
    label: option?.label || row.provider,
    capabilities: option?.capabilities || null,
    displayName: row.displayName,
    priority: row.priority,
    isDefault: row.isDefault,
    isActive: row.isActive,
    config: maskConfig(decryptJsonIfNeeded(row.encryptedConfig)),
    verifiedAt: row.verifiedAt,
    lastTestedAt: row.lastTestedAt,
    lastTestError: row.lastTestError,
    webhookHealth,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serializeDomain(row, { sharedMoviraUsage } = {}) {
  const localPart = String(row.domain || "").split(".")[0] || "events";
  const profile = row.warmupProfile || null;
  const completedOnSharedMovira = profile?.status === "completed" && row.provider === "movira_ses";
  const sharedAllowance = warmupService.sharedMoviraAllowance(row.locationId);
  const todayLimit = completedOnSharedMovira
    ? Number(sharedAllowance.dailyLimit)
    : Number(profile?.dailyLimit || 0);
  const hourLimit = completedOnSharedMovira
    ? Number(sharedAllowance.hourlyLimit)
    : Number(profile?.hourlyLimit || 0);
  const todaySent = completedOnSharedMovira
    ? Number(sharedMoviraUsage?.todaySent ?? profile?.todaySent ?? 0)
    : Number(profile?.todaySent || 0);
  const currentHourSent = completedOnSharedMovira
    ? Number(sharedMoviraUsage?.currentHourSent ?? profile?.currentHourSent ?? 0)
    : Number(profile?.currentHourSent || 0);
  const warmup = profile
    ? {
        id: profile.id,
        status: profile.status,
        stage: profile.stage,
        dailyLimit: todayLimit,
        hourlyLimit: hourLimit,
        todaySent,
        todayLimit,
        currentHourSent,
        hourLimit,
        todayDelivered: profile.todayDelivered,
        todayBounced: profile.todayBounced,
        todayComplaints: profile.todayComplaints,
        todayUnsubscribed: profile.todayUnsubscribed,
        todayOpened: profile.todayOpened,
        todayClicked: profile.todayClicked,
        pct: todayLimit ? Math.min(100, Math.round((todaySent / todayLimit) * 100)) : 0,
        pausedReason: profile.pausedReason,
        windowStartedAt: profile.windowStartedAt,
        hourWindowStartedAt: profile.hourWindowStartedAt,
        startedAt: profile.startedAt,
        completedAt: profile.completedAt,
        lastEvaluatedAt: profile.lastEvaluatedAt,
        events: (profile.events || []).map((event) => ({
          id: event.id,
          eventType: event.eventType,
          fromStage: event.fromStage,
          toStage: event.toStage,
          reason: event.reason,
          metricsSnapshot: event.metricsSnapshot || {},
          createdAt: event.createdAt,
        })),
      }
    : null;
  // Unverified domains auto-expire UNVERIFIED_TTL_DAYS after creation —
  // surface the deadline so the UI can warn customers in red.
  const expiresAt =
    row.status !== "verified"
      ? new Date(new Date(row.createdAt).getTime() + UNVERIFIED_TTL_DAYS * 86400000).toISOString()
      : null;
  return {
    id: row.id,
    locationId: row.locationId,
    domain: row.domain,
    domainType: row.domainType,
    useCase: row.useCase,
    provider: row.provider,
    providerConfigId: row.providerConfigId,
    status: row.status,
    dnsRecords: row.dnsRecords || [],
    warmupPlan: warmupService.getWarmupPlan(),
    postWarmupPolicy: warmupService.getPostWarmupPolicy(row.provider, row.locationId),
    senderName: row.senderName,
    senderEmail: row.senderEmail || (row.domain ? `${localPart}@${row.domain}` : null),
    providerIdentityName: row.providerIdentityName,
    providerIdentityArn: row.providerIdentityArn,
    mailFromDomain: row.mailFromDomain,
    lastDnsCheckedAt: row.lastDnsCheckedAt,
    lastVerificationError: row.lastVerificationError,
    isDefault: row.isDefault,
    isActive: row.isActive,
    warmup,
    warmupStage: warmup?.stage || row.warmupStage || null,
    warmupTodaySent: warmup?.todaySent || row.warmupTodaySent || 0,
    warmupTodayLimit: warmup?.todayLimit || row.warmupTodayLimit || 0,
    verifiedAt: row.verifiedAt,
    expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function getSharedMoviraUsage(domains = []) {
  const today = new Date().toISOString().slice(0, 10);
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  return domains.reduce((usage, domain) => {
    const profile = domain.warmupProfile;
    if (domain.provider !== "movira_ses" || !profile) return usage;
    if (String(profile.windowStartedAt) === today) {
      usage.todaySent += Number(profile.todaySent || 0);
    }
    const hourStartedAt = profile.hourWindowStartedAt
      ? new Date(profile.hourWindowStartedAt).getTime()
      : 0;
    if (hourStartedAt >= oneHourAgo) {
      usage.currentHourSent += Number(profile.currentHourSent || 0);
    }
    return usage;
  }, { todaySent: 0, currentHourSent: 0 });
}

function serializeRoute(row) {
  return {
    id: row.id,
    locationId: row.locationId,
    routeKey: row.routeKey,
    label: row.label,
    domainId: row.domainId,
    trafficPercent: row.trafficPercent,
    frequencyPolicy: row.frequencyPolicy || {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function throwValidation(errors) {
  const err = new Error(errors[0]?.message || "Validation failed");
  err.statusCode = 400;
  err.errors = errors;
  throw err;
}

function validateProviderBody(body, option) {
  const errors = [];
  const provider = String(body.provider || "").trim();
  const domain = String(body.domain || "").trim();
  const displayName = String(body.displayName || "").trim();
  const config = body.config || {};

  if (!provider) {
    errors.push({ field: "provider", message: "Choose an email provider." });
  } else if (!option) {
    errors.push({ field: "provider", message: "This provider is not supported." });
  }

  if (!["transactional", "marketing", "both"].includes(domain)) {
    errors.push({
      field: "domain",
      message: "Choose Transactional, Marketing, or Both.",
    });
  }

  if (displayName && displayName.length > 150) {
    errors.push({ field: "displayName", message: "Display name must be 150 characters or fewer." });
  }

  if (option?.requiresCustomerCredentials) {
    for (const field of option.fields || []) {
      if (!String(config[field] || "").trim()) {
        errors.push({
          field: `config.${field}`,
          message: `${toLabel(field)} is required for ${option.label}.`,
        });
      }
    }
  }

  if (provider === "customer_mailgun") {
    const region = String(config.region || "").toLowerCase();
    if (!["us", "eu"].includes(region)) {
      errors.push({
        field: "config.region",
        message: "Mailgun region must be us or eu.",
      });
    }
  }

  if (config.fromEmail && !isEmail(config.fromEmail)) {
    errors.push({
      field: "config.fromEmail",
      message: "From email must be a valid email address.",
    });
  }

  return errors;
}

function validateDomainBody(body) {
  const errors = [];
  if (!body.locationId) {
    errors.push({
      field: "locationId",
      message: "Select a location before adding a sending domain.",
    });
  }
  if (!body.domain) {
    errors.push({ field: "domain", message: "Enter a sending domain." });
  } else if (!isDomain(body.domain)) {
    errors.push({
      field: "domain",
      message: "Enter a valid domain, for example mail.example.com.",
    });
  }
  if (!["transactional", "marketing", "both"].includes(body.useCase || "marketing")) {
    errors.push({
      field: "useCase",
      message: "Choose Transactional, Marketing, or Both.",
    });
  }
  if (body.provider && !PROVIDER_OPTIONS.some((item) => item.provider === body.provider)) {
    errors.push({ field: "provider", message: "Choose a valid email provider." });
  }
  return errors;
}

async function resolveProviderConfig({ model, locationId, provider, providerConfigId, useCase }) {
  const option = PROVIDER_OPTIONS.find((item) => item.provider === provider);
  if (!option) throwValidation([{ field: "provider", message: "Choose a valid email provider." }]);
  if (useCase !== "both" && !option.supports.includes(useCase)) {
    throwValidation([{ field: "provider", message: "This provider does not support the selected use case." }]);
  }
  if (provider === "movira_ses") return null;
  if (!providerConfigId) {
    throwValidation([{ field: "providerConfigId", message: "Choose a connected provider before adding this domain." }]);
  }

  const row = await model.findByPk(providerConfigId);
  if (
    !row ||
    Number(row.locationId) !== Number(locationId) ||
    row.provider !== provider ||
    row.channel !== "email" ||
    !row.isActive
  ) {
    throwValidation([{ field: "providerConfigId", message: "Choose a valid active provider for this location." }]);
  }
  if (useCase !== "both" && ![useCase, "both"].includes(row.domain)) {
    throwValidation([{ field: "providerConfigId", message: "Provider route does not match the selected domain use case." }]);
  }
  return row;
}

function normalizeDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function isDomain(value) {
  const v = String(value || "").trim();
  if (v.length > 253) return false;
  if (!v.includes(".")) return false;
  return /^(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i.test(v);
}

function toLabel(key) {
  return String(key)
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase());
}

module.exports = {
  getEmailSettings,
  createProvider,
  createDomain,
  listDomains,
  getDomain,
  deleteDomain,
  setDefaultDomain,
  listDomainRoutes,
  verifyDomain,
  verifyProviderConfig,
  updateWarmupControl,
  checkProviderHealth,
  evaluateEmailInfrastructureHealth,
  isHealthCheckDue,
  domainHealthCheckIntervalMinutes,
  providerWebhookGuardConfigured,
  assertLocationOwnership,
  testProvider,
  deleteProvider,
  updateDomainRoute,
};
