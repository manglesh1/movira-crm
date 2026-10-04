require("dotenv").config();

const requiredInProduction = [
  "MOVIRA_CRM_DATABASE_URL",
  "JWT_SECRET",
  "INTERNAL_API_SECRET",
  "MOVIRA_CORE_API_BASE_URL",
  "CRM_ALLOWED_ORIGINS",
  "AWS_REGION",
  "SQS_TRANSACTIONAL_CRITICAL_URL",
  "SQS_TRANSACTIONAL_DEFAULT_URL",
];

function requireProductionEnv() {
  if (process.env.NODE_ENV !== "production") return;
  const missing = requiredInProduction.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing production env vars: ${missing.join(", ")}`);
  }
}

requireProductionEnv();

function booleanEnv(key, fallback = false) {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = String(raw).toLowerCase();
  if (["false", "0", "no", "disable"].includes(value)) return false;
  if (["true", "1", "yes", "require"].includes(value)) return true;
  return fallback;
}

function awsRegionEnv(key, fallback) {
  const value = String(process.env[key] || fallback || "").trim();
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(value)) {
    throw new Error(`${key} must be a valid AWS region like us-east-1 or ca-central-1. Current value: ${value || "missing"}`);
  }
  return value;
}

function postgresIdentifierEnv(key, fallback) {
  const value = String(process.env[key] || fallback || "").trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`${key} must be a valid PostgreSQL identifier. Current value: ${value || "missing"}`);
  }
  return value;
}

function queueUrlEnv(key) {
  if (process.env.NODE_ENV !== "production" && process.env.CRM_USE_REAL_SQS_IN_DEV !== "true") {
    return "";
  }
  return process.env[key] || "";
}

const config = {
  env: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 4100),
  database: {
    crm: {
      url: process.env.MOVIRA_CRM_DATABASE_URL || null,
      envVar: "MOVIRA_CRM_DATABASE_URL",
      schema: postgresIdentifierEnv("CRM_DB_SCHEMA", "crm"),
      ssl: booleanEnv("MOVIRA_CRM_DB_SSL", process.env.NODE_ENV === "production"),
    },
  },
  redisUrl: process.env.REDIS_URL || null,
  jwtSecret: process.env.JWT_SECRET || "dev-only",
  internalApiSecret: process.env.INTERNAL_API_SECRET || "dev-only",
  urls: {
    publicBaseUrl: (process.env.CRM_PUBLIC_BASE_URL || "").replace(/\/+$/, ""),
    trackingBaseUrl: (process.env.CRM_TRACKING_BASE_URL || "").replace(/\/+$/, ""),
  },
  security: {
    allowedOrigins: String(process.env.CRM_ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    allowUnsignedWebhooks: booleanEnv("CRM_ALLOW_UNSIGNED_WEBHOOKS", process.env.NODE_ENV !== "production"),
  },
  integrations: {
    coreApiBaseUrl: (process.env.MOVIRA_CORE_API_BASE_URL || (process.env.NODE_ENV === "production" ? "" : "http://127.0.0.1:5171/api")).replace(/\/+$/, ""),
    meta: {
      appId: process.env.META_APP_ID || "",
      appSecret: process.env.META_APP_SECRET || "",
      graphVersion: process.env.META_GRAPH_VERSION || "v24.0",
      oauthRedirectUri: process.env.META_OAUTH_REDIRECT_URI || "",
      oauthSuccessRedirect: process.env.META_OAUTH_SUCCESS_REDIRECT || "",
      scopes: String(process.env.META_OAUTH_SCOPES || "pages_show_list,pages_manage_metadata,pages_messaging,instagram_basic,instagram_manage_messages")
        .split(",").map((value) => value.trim()).filter(Boolean),
    },
  },
  webhooks: {
    sharedSecret: process.env.CRM_WEBHOOK_SHARED_SECRET || "",
    mailgunSigningKey: process.env.MAILGUN_WEBHOOK_SIGNING_KEY || "",
    sendgridPublicKey: process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY || "",
    postmarkToken: process.env.POSTMARK_WEBHOOK_TOKEN || "",
    postmarkUsername: process.env.POSTMARK_WEBHOOK_USERNAME || "",
    postmarkPassword: process.env.POSTMARK_WEBHOOK_PASSWORD || "",
    metaVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || "",
  },
  credentialsEncryptionKey: process.env.CRM_CREDENTIALS_ENCRYPTION_KEY || "",
  credentialsEncryptionKeyId: process.env.CRM_CREDENTIALS_ENCRYPTION_KEY_ID || "primary",
  credentialsPreviousEncryptionKeys: process.env.CRM_CREDENTIALS_PREVIOUS_KEYS || "{}",
  aws: {
    region: awsRegionEnv("AWS_REGION", "us-east-1"),
    queues: {
      transactionalCritical: queueUrlEnv("SQS_TRANSACTIONAL_CRITICAL_URL"),
      transactionalCriticalDlq: queueUrlEnv("SQS_TRANSACTIONAL_CRITICAL_DLQ_URL"),
      transactionalDefault: queueUrlEnv("SQS_TRANSACTIONAL_DEFAULT_URL"),
      transactionalDefaultDlq: queueUrlEnv("SQS_TRANSACTIONAL_DEFAULT_DLQ_URL"),
      marketingBulk: queueUrlEnv("SQS_MARKETING_BULK_URL"),
      marketingJourney: queueUrlEnv("SQS_MARKETING_JOURNEY_URL"),
      webhookEvents: queueUrlEnv("SQS_WEBHOOK_EVENTS_URL"),
    },
    ses: {
      region: awsRegionEnv("AWS_SES_REGION", "us-east-1"),
      transactionalConfigSet: process.env.SES_TRANSACTIONAL_CONFIG_SET || "movira-transactional",
      marketingConfigSet: process.env.SES_MARKETING_CONFIG_SET || "movira-marketing",
      defaultFrom: process.env.SES_DEFAULT_FROM || "no-reply@movira.app",
      domainProvisioningEnabled: booleanEnv("SES_DOMAIN_PROVISIONING_ENABLED", true),
      capacity: {
        enforcementEnabled: booleanEnv("SES_GLOBAL_CAPACITY_ENFORCEMENT", process.env.NODE_ENV === "production"),
        snapshotTtlSeconds: Number(process.env.SES_CAPACITY_SNAPSHOT_TTL_SECONDS || 60),
        reservationTtlSeconds: Number(process.env.SES_CAPACITY_RESERVATION_TTL_SECONDS || 300),
        transactionalReservePercent: Number(process.env.SES_TRANSACTIONAL_CAPACITY_RESERVE_PERCENT || 20),
        safetyMarginPercent: Number(process.env.SES_CAPACITY_SAFETY_MARGIN_PERCENT || 5),
      },
    },
    s3: {
      marketingAssetsBucket: process.env.S3_MARKETING_ASSETS_BUCKET || "",
      marketingAssetsPrefix: process.env.S3_MARKETING_ASSETS_PREFIX || "marketing-assets",
      publicBaseUrl: process.env.S3_MARKETING_ASSETS_PUBLIC_BASE_URL || "",
      contactExportsBucket: process.env.S3_CONTACT_EXPORTS_BUCKET || "",
      contactExportsPrefix: process.env.S3_CONTACT_EXPORTS_PREFIX || "contact-exports",
    },
  },
  marketing: {
    rateLimits: {
      perMinute: Number(process.env.MARKETING_SEND_RATE_PER_MINUTE || 60),
      perHour: Number(process.env.MARKETING_SEND_RATE_PER_HOUR || 1000),
    },
  },
  queueJobs: {
    pollMs: Number(process.env.CRM_QUEUE_WORKER_POLL_MS || 2000),
    batchSize: Number(process.env.CRM_QUEUE_WORKER_BATCH_SIZE || 10),
    staleLockMs: Number(process.env.CRM_QUEUE_WORKER_STALE_LOCK_MS || 10 * 60 * 1000),
  },
  conversations: {
    workerPollMs: Number(process.env.CONVERSATIONS_WORKER_POLL_MS || 1500),
    workerBatchSize: Number(process.env.CONVERSATIONS_WORKER_BATCH_SIZE || 10),
    outboundMaxAttempts: Number(process.env.CONVERSATIONS_OUTBOUND_MAX_ATTEMPTS || 6),
    staleLockMs: Number(process.env.CONVERSATIONS_STALE_LOCK_MS || 5 * 60 * 1000),
  },
  // Org-level sender/business identity injected as default {{business.*}} merge
  // data for marketing sends (compliance footer). Per-campaign body.data.business
  // overrides these. business.address is a legal requirement before real sends.
  business: {
    name: process.env.CRM_BUSINESS_NAME || "",
    address: process.env.CRM_BUSINESS_ADDRESS || "",
    phone: process.env.CRM_BUSINESS_PHONE || "",
    email: process.env.CRM_BUSINESS_EMAIL || "",
    website: process.env.CRM_BUSINESS_WEBSITE || "",
  },
};

module.exports = config;
