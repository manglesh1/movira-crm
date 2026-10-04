require("dotenv").config();

const config = require("../config");
const logger = require("../shared/logger");
const sqs = require("../modules/messaging-core/aws/sqsClient");
const processor = require("../modules/marketing/email/workerProcessor");
const heartbeat = require("../modules/marketing/email/workerHeartbeatService");

const queues = [
  config.aws.queues.marketingBulk,
  config.aws.queues.marketingJourney,
].filter(Boolean);

let stopping = false;
const workerId = heartbeat.defaultWorkerId("marketing-worker");

process.on("SIGINT", () => {
  stopping = true;
});

process.on("SIGTERM", () => {
  stopping = true;
});

async function run() {
  if (queues.length === 0) {
    logger.warn("No marketing SQS queues configured; worker exiting");
    await heartbeat.safeHeartbeat({
      workerId,
      status: "stopped",
      event: "no_queues",
      metadata: { queuesConfigured: 0 },
    }, logger);
    return;
  }

  logger.info({ queues: queues.length }, "marketing worker started");
  await heartbeat.safeHeartbeat({
    workerId,
    status: "running",
    event: "started",
    metadata: { queuesConfigured: queues.length },
  }, logger);

  while (!stopping) {
    for (const queueUrl of queues) {
      await pollQueue(queueUrl);
    }
    await heartbeat.safeHeartbeat({
      workerId,
      status: "running",
      event: "heartbeat",
      metadata: { queuesConfigured: queues.length },
    }, logger);
  }

  logger.info("marketing worker stopped");
  await heartbeat.safeHeartbeat({
    workerId,
    status: "stopped",
    event: "stopped",
  }, logger);
}

async function pollQueue(queueUrl) {
  const queueType = queueUrl === config.aws.queues.marketingJourney ? "journey" : "bulk";
  await heartbeat.safeHeartbeat({
    workerId,
    queueType,
    status: "polling",
    event: "poll",
  }, logger);
  const messages = await sqs.receiveMessages(queueUrl, {
    maxMessages: 5,
    waitTimeSeconds: 10,
  });

  for (const message of messages) {
    try {
      const result = await processor.processMarketingSqsMessage(message);
      await sqs.deleteMessage(queueUrl, message.ReceiptHandle);
      logger.info({ result }, "marketing message processed");
      await heartbeat.safeHeartbeat({
        workerId,
        queueType,
        status: "running",
        event: "processed",
        processedDelta: result?.skipped ? 0 : 1,
      }, logger);
    } catch (err) {
      const isRateLimited = ["MARKETING_RATE_LIMITED", "MARKETING_CAPACITY_RESERVED", "PROVIDER_CAPACITY_HELD", "PROVIDER_QUOTA_UNAVAILABLE"].includes(err.code);
      const isPaused = err.code === "CAMPAIGN_PAUSED";
      logger[isRateLimited || isPaused ? "warn" : "error"](
        { err },
        isPaused ? "marketing campaign paused" : isRateLimited ? "marketing send rate limited" : "marketing message failed"
      );
      await heartbeat.safeHeartbeat({
        workerId,
        queueType,
        status: isPaused ? "paused" : isRateLimited ? "rate_limited" : "error",
        event: isPaused ? "paused" : isRateLimited ? "rate_limited" : "failed",
        failedDelta: isRateLimited || isPaused ? 0 : 1,
        error: isRateLimited || isPaused ? null : err,
        metadata: isRateLimited
          ? { rateLimit: err.details || null, retryAfterSeconds: err.retryAfterSeconds || null }
          : isPaused
          ? { campaignId: err.campaignId || null }
          : {},
      }, logger);
      // SQS retry + DLQ policy owns redelivery.
    }
  }
}

run().catch((err) => {
  logger.fatal({ err }, "marketing worker crashed");
  process.exit(1);
});
