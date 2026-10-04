const { Op, fn, col } = require("sequelize");
const config = require("../../config");
const { getModels } = require("../../db/models");
const repository = require("./repository");
const { enqueueTransactionalMessage } = require("../messaging-core/aws/sqsClient");
const sqs = require("../messaging-core/aws/sqsClient");
const { STATUS } = require("./constants");
const suppressionService = require("../marketing/email/suppressionService");

const STATUSES = [
  STATUS.PENDING,
  STATUS.ENQUEUE_SKIPPED,
  STATUS.QUEUED,
  STATUS.SENDING,
  STATUS.SENT,
  STATUS.DELIVERED,
  STATUS.FAILED,
  STATUS.CANCELLED,
];
const RECOVERABLE_STATUSES = [STATUS.ENQUEUE_SKIPPED, STATUS.PENDING, STATUS.FAILED];
const EVENT_COUNT_KEYS = [
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "unsubscribed",
];

const QUEUES = [
  { key: "critical", label: "Critical", env: "SQS_TRANSACTIONAL_CRITICAL_URL", url: () => config.aws.queues.transactionalCritical, kind: "source" },
  { key: "default", label: "Default", env: "SQS_TRANSACTIONAL_DEFAULT_URL", url: () => config.aws.queues.transactionalDefault, kind: "source" },
  { key: "critical_dlq", label: "Critical DLQ", env: "SQS_TRANSACTIONAL_CRITICAL_DLQ_URL", url: () => config.aws.queues.transactionalCriticalDlq, kind: "dlq" },
  { key: "default_dlq", label: "Default DLQ", env: "SQS_TRANSACTIONAL_DEFAULT_DLQ_URL", url: () => config.aws.queues.transactionalDefaultDlq, kind: "dlq" },
  { key: "webhook_events", label: "SES events", env: "SQS_WEBHOOK_EVENTS_URL", url: () => config.aws.queues.webhookEvents, kind: "webhook" },
];

function requireLocation(locationId) {
  if (!locationId) return null;
  return Number(locationId);
}

function messageWhere({ locationId, status, q } = {}) {
  const where = {};
  const loc = requireLocation(locationId);
  if (loc) where.locationId = loc;
  if (status) where.status = status;
  if (q) {
    const like = { [Op.iLike]: `%${String(q).trim()}%` };
    where[Op.or] = [
      { recipientAddress: like },
      { templateKey: like },
      { sourceEventType: like },
      { sourceResourceId: like },
      { idempotencyKey: like },
    ];
  }
  return where;
}

async function getQueueMonitoring({ locationId, staleMinutes = 15 } = {}) {
  const loc = requireLocation(locationId);
  const staleCutoff = new Date(Date.now() - Math.max(1, Number(staleMinutes) || 15) * 60 * 1000);
  const { TransactionalMessage, TransactionalDeliveryEvent, CrmMarketingWorkerHeartbeat } = getModels();
  const baseWhere = loc ? { locationId: loc } : {};

  const [statusRows, eventRows, staleQueued, stuckSending, recentFailures, recentRecoverable, recentEvents, workers, queueStates] = await Promise.all([
    TransactionalMessage.findAll({
      attributes: ["status", [fn("COUNT", col("id")), "count"]],
      where: baseWhere,
      group: ["status"],
      raw: true,
    }),
    TransactionalDeliveryEvent.findAll({
      attributes: ["eventType", [fn("COUNT", fn("DISTINCT", col("TransactionalDeliveryEvent.messageId"))), "count"]],
      where: { eventType: { [Op.in]: EVENT_COUNT_KEYS } },
      include: loc
        ? [{ model: TransactionalMessage, as: "message", attributes: [], where: { locationId: loc }, required: true }]
        : [],
      group: ["eventType"],
      raw: true,
    }),
    TransactionalMessage.count({
      where: {
        ...baseWhere,
        status: { [Op.in]: [STATUS.PENDING, STATUS.ENQUEUE_SKIPPED, STATUS.QUEUED] },
        createdAt: { [Op.lt]: staleCutoff },
      },
    }),
    TransactionalMessage.count({
      where: {
        ...baseWhere,
        status: STATUS.SENDING,
        updatedAt: { [Op.lt]: staleCutoff },
      },
    }),
    TransactionalMessage.findAll({
      where: { ...baseWhere, status: STATUS.FAILED },
      order: [["updatedAt", "DESC"]],
      limit: 8,
    }),
    TransactionalMessage.findAll({
      where: { ...baseWhere, status: { [Op.in]: RECOVERABLE_STATUSES } },
      order: [["updatedAt", "DESC"]],
      limit: 12,
    }),
    TransactionalDeliveryEvent.findAll({
      include: loc
        ? [{ model: TransactionalMessage, as: "message", attributes: ["locationId", "recipientAddress"], where: { locationId: loc }, required: true }]
        : [{ model: TransactionalMessage, as: "message", attributes: ["locationId", "recipientAddress"], required: false }],
      order: [["occurredAt", "DESC"]],
      limit: 12,
    }),
    CrmMarketingWorkerHeartbeat.findAll({
      where: { workerType: { [Op.in]: ["transactional-worker", "webhook-events-worker"] } },
      order: [["lastHeartbeatAt", "DESC"]],
      limit: 10,
    }),
    probeQueues({ queueType: "all", soft: true }),
  ]);

  const statusCounts = STATUSES.reduce((acc, status) => {
    acc[status] = 0;
    return acc;
  }, {});
  for (const row of statusRows) statusCounts[row.status] = Number(row.count || 0);
  const eventCounts = EVENT_COUNT_KEYS.reduce((acc, eventType) => {
    acc[eventType] = 0;
    return acc;
  }, {});
  for (const row of eventRows) eventCounts[row.eventType] = Number(row.count || 0);

  return {
    generatedAt: new Date().toISOString(),
    queues: queueStates.results,
    summary: {
      waiting: statusCounts.pending + statusCounts.enqueue_skipped + statusCounts.queued,
      inFlight: statusCounts.sending,
      sent: statusCounts.sent + statusCounts.delivered,
      failed: statusCounts.failed,
      cancelled: statusCounts.cancelled,
      staleQueued,
      stuckSending,
      dlqVisible: queueStates.results.filter((q) => q.kind === "dlq").reduce((sum, q) => sum + Number(q.attributes?.visible || 0), 0),
    },
    statusCounts,
    eventCounts,
    recentFailures: recentFailures.map(serializeMessage),
    recentRecoverable: recentRecoverable.map(serializeMessage),
    recentEvents: recentEvents.map(serializeEvent),
    workers: workers.map(serializeHeartbeat),
  };
}

async function getWorkerVerification() {
  const { CrmMarketingWorkerHeartbeat } = getModels();
  const latestWorker = await CrmMarketingWorkerHeartbeat.findOne({
    where: { workerType: "transactional-worker" },
    order: [["lastHeartbeatAt", "DESC"]],
  });
  const latestWebhookWorker = await CrmMarketingWorkerHeartbeat.findOne({
    where: { workerType: "webhook-events-worker" },
    order: [["lastHeartbeatAt", "DESC"]],
  });
  const workerHealth = latestWorker ? heartbeatHealth(latestWorker.lastHeartbeatAt) : "missing";
  const webhookWorkerHealth = latestWebhookWorker ? heartbeatHealth(latestWebhookWorker.lastHeartbeatAt) : "missing";
  return {
    generatedAt: new Date().toISOString(),
    dryRun: true,
    region: config.aws.region,
    queues: QUEUES.map(queueSummary),
    worker: latestWorker ? serializeHeartbeat(latestWorker) : null,
    webhookWorker: latestWebhookWorker ? serializeHeartbeat(latestWebhookWorker) : null,
    commands: {
      startWorker: "npm run worker:transactional",
      startWebhookWorker: "npm run worker:webhooks",
      runServer: "npm run start",
      requiredEnv: ["AWS_REGION", "SQS_TRANSACTIONAL_CRITICAL_URL", "SQS_TRANSACTIONAL_DEFAULT_URL", "SQS_WEBHOOK_EVENTS_URL"],
    },
    checks: [
      check("aws_region", Boolean(config.aws.region), `AWS region: ${config.aws.region || "missing"}`),
      check("critical_queue_url", Boolean(config.aws.queues.transactionalCritical), "Critical queue URL is configured."),
      check("default_queue_url", Boolean(config.aws.queues.transactionalDefault), "Default queue URL is configured."),
      check("critical_dlq_url", Boolean(config.aws.queues.transactionalCriticalDlq), "Critical DLQ URL is configured."),
      check("default_dlq_url", Boolean(config.aws.queues.transactionalDefaultDlq), "Default DLQ URL is configured."),
      check("webhook_events_queue_url", Boolean(config.aws.queues.webhookEvents), "SES webhook events queue URL is configured."),
      check("worker_heartbeat", workerHealth === "online", latestWorker ? `Latest worker is ${workerHealth}.` : "No transactional worker heartbeat found."),
      check("worker_polled", Boolean(latestWorker?.lastPollAt), latestWorker?.lastPollAt ? "Worker has polled SQS." : "Worker has not polled SQS yet."),
      check("webhook_worker_heartbeat", webhookWorkerHealth === "online", latestWebhookWorker ? `Webhook worker is ${webhookWorkerHealth}.` : "No webhook events worker heartbeat found."),
      check("webhook_worker_polled", Boolean(latestWebhookWorker?.lastPollAt), latestWebhookWorker?.lastPollAt ? "Webhook worker has polled SQS." : "Webhook worker has not polled SQS yet."),
    ],
  };
}

async function probeQueues({ queueType = "all", soft = false } = {}) {
  const selected = QUEUES.filter((queue) => queueType === "all" || queue.key === queueType);
  const results = [];
  for (const queue of selected) {
    const url = queue.url();
    if (!url) {
      results.push({
        key: queue.key,
        label: queue.label,
        kind: queue.kind,
        env: queue.env,
        configured: false,
        ok: false,
        error: `${queue.env} is missing.`,
      });
      continue;
    }
    try {
      const attributes = await sqs.getQueueAttributes(url);
      results.push({
        key: queue.key,
        label: queue.label,
        kind: queue.kind,
        env: queue.env,
        configured: true,
        ok: true,
        url: redactQueueUrl(url),
        attributes: normalizeAttributes(attributes),
      });
    } catch (err) {
      results.push({
        key: queue.key,
        label: queue.label,
        kind: queue.kind,
        env: queue.env,
        configured: true,
        ok: false,
        url: redactQueueUrl(url),
        error: err.message,
      });
      if (!soft) continue;
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    probe: "GetQueueAttributes",
    queueType,
    results,
    ok: results.length > 0 && results.every((result) => result.ok || (soft && !result.configured)),
  };
}

async function listFailedMessages({ locationId, q, page = 1, pageSize = 25 } = {}) {
  const { TransactionalMessage } = getModels();
  const limit = Math.min(100, Math.max(1, Number(pageSize) || 25));
  const offset = (Math.max(1, Number(page) || 1) - 1) * limit;
  const where = messageWhere({ locationId, status: STATUS.FAILED, q });
  const { rows, count } = await TransactionalMessage.findAndCountAll({
    where,
    order: [["updatedAt", "DESC"]],
    limit,
    offset,
  });
  return {
    items: rows.map(serializeMessage),
    total: count,
    page: Math.max(1, Number(page) || 1),
    pageSize: limit,
    groups: failureGroups(rows),
  };
}

async function retryMessage(messageId, body = {}) {
  const message = await repository.findMessageById(messageId);
  if (!message) {
    const err = new Error("Transactional message not found");
    err.statusCode = 404;
    throw err;
  }
  if (![STATUS.FAILED, STATUS.ENQUEUE_SKIPPED, STATUS.PENDING].includes(message.status)) {
    const err = new Error("Only failed, pending, or enqueue-skipped transactional messages can be retried.");
    err.statusCode = 400;
    throw err;
  }

  const { TransactionalDeliveryEvent } = getModels();
  const manualRetryLimit = Math.max(1, Number(process.env.TRANSACTIONAL_MANUAL_RETRY_LIMIT || 5));
  const priorManualRetries = await TransactionalDeliveryEvent.count({
    where: {
      messageId: message.id,
      eventType: { [Op.in]: ["retry_queued", "retry_enqueue_skipped"] },
    },
  });
  if (priorManualRetries >= manualRetryLimit && body.overrideRetryLimit !== true) {
    const err = new Error(`Manual retry limit reached (${manualRetryLimit}). Review the failure before overriding the limit.`);
    err.statusCode = 409;
    err.code = "MANUAL_RETRY_LIMIT_REACHED";
    err.details = { priorManualRetries, manualRetryLimit, safeToOverride: true };
    throw err;
  }

  if (message.channel === "email") {
    const suppression = await suppressionService.isSuppressed(message.locationId, message.recipientAddress);
    if (suppression) {
      const suppressed = await repository.markSuppressed(message, suppression);
      return {
        message: serializeMessage(suppressed),
        enqueue: { skipped: true, reason: "recipient_suppressed", suppressionId: suppression.id },
      };
    }
  }

  await message.update({ status: STATUS.PENDING, failedAt: null, lastError: null });
  const enqueue = await enqueueTransactionalMessage({
    messageId: message.id,
    channel: message.channel,
    priority: body.priority || message.priority,
  });
  const updated = await repository.markQueued(message, enqueue);
  await repository.createDeliveryEvent({
    messageId: updated.id,
    eventType: enqueue?.skipped ? "retry_enqueue_skipped" : "retry_queued",
    payload: {
      source: "transactional_failed_inbox",
      reason: body.reason || "Manual retry",
      enqueue,
    },
  });
  return { message: serializeMessage(updated), enqueue };
}

async function retryFailedMessages(body = {}) {
  const { TransactionalMessage } = getModels();
  const where = messageWhere({ locationId: body.locationId, status: STATUS.FAILED, q: body.q });
  const messageIds = Array.isArray(body.messageIds) ? body.messageIds.filter(Boolean) : [];
  if (messageIds.length) where.id = { [Op.in]: messageIds };
  const rows = await TransactionalMessage.findAll({
    where,
    order: [["updatedAt", "DESC"]],
    limit: Math.min(100, Math.max(1, Number(body.limit) || 100)),
  });

  const retried = [];
  const failed = [];
  for (const row of rows) {
    try {
      const result = await retryMessage(row.id, { reason: body.reason || "Bulk retry from transactional failed inbox" });
      retried.push(result.message);
    } catch (err) {
      failed.push({ id: row.id, recipientAddress: row.recipientAddress, error: err.message });
    }
  }
  return {
    retried,
    failed,
    totalRetried: retried.length,
    totalFailed: failed.length,
  };
}

async function retryRecoverableMessages(body = {}) {
  const { TransactionalMessage } = getModels();
  const requestedStatuses = Array.isArray(body.statuses)
    ? body.statuses
    : body.status
      ? [body.status]
      : RECOVERABLE_STATUSES;
  const statuses = requestedStatuses.filter((status) => RECOVERABLE_STATUSES.includes(status));
  if (!statuses.length) {
    const err = new Error("No recoverable transactional statuses selected.");
    err.statusCode = 400;
    throw err;
  }

  const where = messageWhere({ locationId: body.locationId, q: body.q });
  where.status = { [Op.in]: statuses };

  const rows = await TransactionalMessage.findAll({
    where,
    order: [["updatedAt", "DESC"]],
    limit: Math.min(100, Math.max(1, Number(body.limit) || 100)),
  });

  const retried = [];
  const failed = [];
  for (const row of rows) {
    try {
      retried.push(await retryMessage(row.id, {
        priority: body.priority || row.priority,
        reason: body.reason || "Bulk recoverable retry",
      }));
    } catch (err) {
      failed.push({ id: row.id, error: err.message });
    }
  }
  return { retried, failed, total: rows.length };
}

function serializeMessage(row) {
  return {
    id: row.id,
    locationId: row.locationId,
    sourceSystem: row.sourceSystem,
    sourceEventType: row.sourceEventType,
    sourceResourceType: row.sourceResourceType,
    sourceResourceId: row.sourceResourceId,
    channel: row.channel,
    recipientAddress: row.recipientAddress,
    templateKey: row.templateKey,
    priority: row.priority,
    status: row.status,
    provider: row.provider,
    providerMessageId: row.providerMessageId,
    queuedAt: row.queuedAt,
    sentAt: row.sentAt,
    deliveredAt: row.deliveredAt,
    failedAt: row.failedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serializeEvent(row) {
  return {
    id: row.id,
    messageId: row.messageId,
    recipientAddress: row.message?.recipientAddress || null,
    eventType: row.eventType,
    provider: row.provider,
    providerMessageId: row.providerMessageId,
    payload: row.payload || {},
    occurredAt: row.occurredAt,
  };
}

function serializeHeartbeat(row) {
  const ageSeconds = row.lastHeartbeatAt
    ? Math.round((Date.now() - new Date(row.lastHeartbeatAt).getTime()) / 1000)
    : null;
  return {
    id: row.id,
    workerType: row.workerType,
    workerId: row.workerId,
    queueType: row.queueType,
    status: row.status,
    health: heartbeatHealth(row.lastHeartbeatAt),
    ageSeconds,
    lastStartedAt: row.lastStartedAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
    lastPollAt: row.lastPollAt,
    lastProcessedAt: row.lastProcessedAt,
    lastErrorAt: row.lastErrorAt,
    lastError: row.lastError,
    totalProcessed: row.totalProcessed,
    totalFailed: row.totalFailed,
    metadata: row.metadata || {},
  };
}

function heartbeatHealth(lastHeartbeatAt) {
  if (!lastHeartbeatAt) return "missing";
  const ageSeconds = Math.round((Date.now() - new Date(lastHeartbeatAt).getTime()) / 1000);
  if (ageSeconds <= 120) return "online";
  if (ageSeconds <= 600) return "stale";
  return "offline";
}

function queueSummary(queue) {
  const url = queue.url();
  return {
    key: queue.key,
    label: queue.label,
    kind: queue.kind,
    env: queue.env,
    configured: Boolean(url),
    url: url ? redactQueueUrl(url) : null,
  };
}

function normalizeAttributes(attributes = {}) {
  let redrivePolicy = null;
  if (attributes.RedrivePolicy) {
    try {
      const parsed = JSON.parse(attributes.RedrivePolicy);
      redrivePolicy = {
        maxReceiveCount: parsed.maxReceiveCount,
        deadLetterTargetArn: parsed.deadLetterTargetArn ? parsed.deadLetterTargetArn.replace(/:\d+:/, ":***:") : null,
      };
    } catch (_err) {
      redrivePolicy = { raw: "unparseable" };
    }
  }
  return {
    visible: Number(attributes.ApproximateNumberOfMessages || 0),
    inFlight: Number(attributes.ApproximateNumberOfMessagesNotVisible || 0),
    delayed: Number(attributes.ApproximateNumberOfMessagesDelayed || 0),
    visibilityTimeoutSeconds: Number(attributes.VisibilityTimeout || 0),
    retentionSeconds: Number(attributes.MessageRetentionPeriod || 0),
    redrivePolicy,
  };
}

function failureGroups(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = String(row.lastError || "Unknown failure").slice(0, 160);
    const existing = map.get(key) || { key, message: key, count: 0, latestAt: null };
    existing.count += 1;
    existing.latestAt = existing.latestAt && existing.latestAt > row.updatedAt ? existing.latestAt : row.updatedAt;
    map.set(key, existing);
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

function check(key, ok, message) {
  return { key, ok, message };
}

function redactQueueUrl(url) {
  return String(url || "").replace(/(https:\/\/sqs\.[^/]+\.amazonaws\.com\/)\d+(\/.+)/, "$1***$2");
}

module.exports = {
  getQueueMonitoring,
  getWorkerVerification,
  probeQueues,
  listFailedMessages,
  retryMessage,
  retryFailedMessages,
  retryRecoverableMessages,
};
