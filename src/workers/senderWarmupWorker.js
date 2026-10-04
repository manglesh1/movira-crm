require("dotenv").config();
const logger = require("../shared/logger");
const warmupService = require("../modules/messaging-core/warmup/senderWarmupService");
const heartbeat = require("../modules/marketing/email/workerHeartbeatService");

const INTERVAL_MINUTES = Number(process.env.SENDER_WARMUP_EVALUATOR_INTERVAL_MINUTES || 60);
const workerId = heartbeat.defaultWorkerId("warmup-worker");

async function runOnce() {
  try {
    const results = await warmupService.evaluateAll();
    logger.info({ count: results.length, results }, "sender warmup evaluation completed");
    await heartbeat.safeHeartbeat({ workerType: "warmup-worker", workerId, event: "poll", status: "running", processedDelta: results.length }, logger);
  } catch (err) {
    logger.error({ err }, "sender warmup evaluation failed");
    await heartbeat.safeHeartbeat({ workerType: "warmup-worker", workerId, event: "poll", status: "error", error: err, failedDelta: 1 }, logger);
  }
}

async function start() {
  logger.info({ intervalMinutes: INTERVAL_MINUTES }, "sender warmup worker started");
  await heartbeat.safeHeartbeat({ workerType: "warmup-worker", workerId, event: "started", status: "running" }, logger);
  await runOnce();
  const handle = setInterval(runOnce, Math.max(1, INTERVAL_MINUTES) * 60 * 1000);
  if (handle.unref) handle.unref();
}

start();
