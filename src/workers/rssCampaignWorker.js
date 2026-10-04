require("dotenv").config();
const logger = require("../shared/logger");
const rss = require("../modules/marketing/email/rssCampaignService");
const heartbeat = require("../modules/marketing/email/workerHeartbeatService");

const workerId = `rss-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const intervalMs = Math.max(15000, Number(process.env.CRM_RSS_POLL_WORKER_INTERVAL_MS || 60000));
let running = false;

async function runOnce() {
  if (running) return;
  running = true;
  try {
    const rows = await rss.claimDue({ workerId, limit: 10 });
    let failed = 0;
    for (const row of rows) {
      try { await rss.pollRow(row); } catch (err) {
        failed += 1;
        await row.update({ lastError: String(err.message || err).slice(0, 2000), lastPolledAt: new Date(), nextPollAt: new Date(Date.now() + Number(row.intervalMinutes || 60) * 60000), lockedAt: null, lockedBy: null });
        logger.warn({ err, rssCampaignId: row.id }, "RSS campaign poll failed");
      }
    }
    await heartbeat.safeHeartbeat({ workerType: "rss-worker", workerId, event: "poll", status: failed ? "attention" : "running", processedDelta: rows.length - failed, failedDelta: failed }, logger);
  } catch (err) {
    await heartbeat.safeHeartbeat({ workerType: "rss-worker", workerId, event: "poll", status: "error", error: err, failedDelta: 1 }, logger);
    throw err;
  } finally { running = false; }
}

logger.info({ workerId, intervalMs }, "RSS campaign worker started");
heartbeat.safeHeartbeat({ workerType: "rss-worker", workerId, event: "started", status: "running" }, logger);
runOnce().catch((err) => logger.error({ err }, "RSS campaign worker iteration failed"));
const timer = setInterval(() => runOnce().catch((err) => logger.error({ err }, "RSS campaign worker iteration failed")), intervalMs);
timer.unref?.();
