require("dotenv").config();
const logger = require("../shared/logger");
const emailSettingsService = require("../modules/settings/email/service");
const heartbeat = require("../modules/marketing/email/workerHeartbeatService");

const INTERVAL_MINUTES = Math.max(
  1,
  Number(process.env.EMAIL_INFRA_HEALTH_INTERVAL_MINUTES || 15)
);
const workerId = heartbeat.defaultWorkerId("email-health-worker");

async function runOnce() {
  try {
    const result = await emailSettingsService.evaluateEmailInfrastructureHealth();
    const providerFailures = result.providers.filter((item) => !item.ok);
    const domainFailures = result.domains.filter((item) => !item.ok);
    logger.info(
      {
        providersChecked: result.providers.length,
        providerFailures: providerFailures.length,
        domainsChecked: result.domains.length,
        domainFailures: domainFailures.length,
      },
      "email infrastructure health evaluation completed"
    );
    if (providerFailures.length || domainFailures.length) {
      logger.warn({ providerFailures, domainFailures }, "email infrastructure needs attention");
    }
    await heartbeat.safeHeartbeat({
      workerType: "email-health-worker",
      workerId,
      event: "poll",
      status: providerFailures.length || domainFailures.length ? "attention" : "running",
      processedDelta: result.providers.length + result.domains.length,
      failedDelta: providerFailures.length + domainFailures.length,
      metadata: { providersChecked: result.providers.length, domainsChecked: result.domains.length },
    }, logger);
  } catch (err) {
    logger.error({ err }, "email infrastructure health evaluation failed");
    await heartbeat.safeHeartbeat({ workerType: "email-health-worker", workerId, event: "poll", status: "error", error: err, failedDelta: 1 }, logger);
  }
}

async function start() {
  logger.info({ intervalMinutes: INTERVAL_MINUTES }, "email infrastructure health worker started");
  await heartbeat.safeHeartbeat({ workerType: "email-health-worker", workerId, event: "started", status: "running" }, logger);
  await runOnce();
  const handle = setInterval(runOnce, INTERVAL_MINUTES * 60 * 1000);
  if (handle.unref) handle.unref();
}

start();
