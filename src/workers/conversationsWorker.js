require("dotenv").config();

const config = require("../config");
const logger = require("../shared/logger");
const outbound = require("../modules/conversations/outboundService");

let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  const workerId = `${process.env.HOSTNAME || "local"}:${process.pid}:conversations-worker`;
  logger.info({ workerId }, "conversations worker started");
  while (!stopping) {
    const events = await outbound.claimSendEvents({ workerId, limit: config.conversations.workerBatchSize });
    if (!events.length) {
      await sleep(config.conversations.workerPollMs);
      continue;
    }
    for (const event of events) {
      try {
        const result = await outbound.processSendEvent(event);
        const level = result.failed ? "error" : result.retrying ? "warn" : "info";
        logger[level]({ outboxId: event.id, messageId: event.aggregateId, result }, "conversation outbound event processed");
      } catch (err) {
        logger.error({ err, outboxId: event.id, messageId: event.aggregateId }, "conversation outbound event crashed");
        await event.update({ status: "pending", lockedAt: null, availableAt: new Date(Date.now() + 30_000), lastErrorCode: "worker_crash", lastErrorMessageSafe: "Worker failed before recording the provider result." }).catch(() => {});
      }
    }
  }
  logger.info({ workerId }, "conversations worker stopped");
}

run().catch((err) => {
  logger.fatal({ err }, "conversations worker crashed");
  process.exit(1);
});
