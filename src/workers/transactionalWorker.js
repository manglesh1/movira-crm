require("dotenv").config();

const config = require("../config");
const logger = require("../shared/logger");
const sqs = require("../modules/messaging-core/aws/sqsClient");
const processor = require("../modules/transactional/workerProcessor");
const heartbeat = require("../modules/marketing/email/workerHeartbeatService");

const queues = [
  config.aws.queues.transactionalCritical,
  config.aws.queues.transactionalDefault,
].filter(Boolean);

let stopping = false;
const workerId = heartbeat.defaultWorkerId("transactional-worker");

process.on("SIGINT", () => {
  stopping = true;
});

process.on("SIGTERM", () => {
  stopping = true;
});

async function run() {
  if (queues.length === 0) {
    logger.warn("No transactional SQS queues configured; worker exiting");
    await heartbeat.safeHeartbeat({
      workerType: "transactional-worker",
      workerId,
      status: "stopped",
      event: "no_queues",
      metadata: { queuesConfigured: 0 },
    }, logger);
    return;
  }

  logger.info({ queues: queues.length }, "transactional worker started");
  await heartbeat.safeHeartbeat({
    workerType: "transactional-worker",
    workerId,
    status: "running",
    event: "started",
    metadata: { queuesConfigured: queues.length },
  }, logger);

  while (!stopping) {
    for (const queueUrl of queues) {
      await pollQueue(queueUrl);
    }
  }

  logger.info("transactional worker stopped");
  await heartbeat.safeHeartbeat({
    workerType: "transactional-worker",
    workerId,
    status: "stopped",
    event: "stopped",
  }, logger);
}

async function pollQueue(queueUrl) {
  const queueType = queueUrl === config.aws.queues.transactionalCritical ? "critical" : "default";
  await heartbeat.safeHeartbeat({
    workerType: "transactional-worker",
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
      const result = await processor.processTransactionalSqsMessage(message);

      if (result?.skipped && result.reason === "message_not_found") {
        logger.warn(
          { messageId: result.messageId, queueType },
          "transactional message row not found; leaving SQS message for retry"
        );
        continue;
      }

      await sqs.deleteMessage(queueUrl, message.ReceiptHandle);
      logger.info({ result }, "transactional message processed");
      await heartbeat.safeHeartbeat({
        workerType: "transactional-worker",
        workerId,
        queueType,
        status: "running",
        event: "processed",
        processedDelta: result?.skipped ? 0 : 1,
      }, logger);
    } catch (err) {
      const isCapacityHeld = ["PROVIDER_CAPACITY_HELD", "PROVIDER_QUOTA_UNAVAILABLE"].includes(err.code);
      logger[isCapacityHeld ? "warn" : "error"]({ err }, isCapacityHeld ? "transactional email capacity held" : "transactional message failed");
      await heartbeat.safeHeartbeat({
        workerType: "transactional-worker",
        workerId,
        queueType,
        status: isCapacityHeld ? "rate_limited" : "error",
        event: isCapacityHeld ? "rate_limited" : "failed",
        failedDelta: isCapacityHeld ? 0 : 1,
        error: isCapacityHeld ? null : err,
        metadata: isCapacityHeld ? { retryAfterSeconds: err.retryAfterSeconds || null, capacity: err.details || null } : {},
      }, logger);
      // Do not delete the SQS message. SQS retry + DLQ policy owns redelivery.
    }
  }
}

run().catch((err) => {
  logger.fatal({ err }, "transactional worker crashed");
  process.exit(1);
});
