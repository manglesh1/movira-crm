const { Op } = require("sequelize");
const { getModels } = require("../../db/models");
const config = require("../../config");

const JOB_TYPES = {
  AUTOMATION_EVENT: "automation.event",
  AUTOMATION_ENROLLMENT: "automation.enrollment",
  AUTOMATION_RESUME: "automation.resume",
  CONTACTS_BULK_ACTION: "contacts.bulk_action",
  CONTACTS_EXPORT: "contacts.export",
  CONTACTS_FILTER_COUNT: "contacts.filter_count",
  MARKETING_CAMPAIGN_AUDIENCE: "marketing.campaign_audience",
  MARKETING_CAMPAIGN_DISPATCH: "marketing.campaign_dispatch",
  MARKETING_RECIPIENT_BATCH: "marketing.recipient_batch",
  MARKETING_DRIP_STEP: "marketing.drip_step",
  SEGMENTS_REFRESH_LOCATION: "segments.refresh_location",
  SEGMENT_REFRESH: "segments.refresh_one",
};

const QUEUES = {
  AUTOMATION: "automation",
  CONTACTS: "contacts",
  MARKETING: "marketing",
  SEGMENTS: "segments",
};

const JOB_QUEUE = {
  [JOB_TYPES.AUTOMATION_EVENT]: QUEUES.AUTOMATION,
  [JOB_TYPES.AUTOMATION_ENROLLMENT]: QUEUES.AUTOMATION,
  [JOB_TYPES.AUTOMATION_RESUME]: QUEUES.AUTOMATION,
  [JOB_TYPES.CONTACTS_BULK_ACTION]: QUEUES.CONTACTS,
  [JOB_TYPES.CONTACTS_EXPORT]: QUEUES.CONTACTS,
  [JOB_TYPES.CONTACTS_FILTER_COUNT]: QUEUES.CONTACTS,
  [JOB_TYPES.MARKETING_CAMPAIGN_AUDIENCE]: QUEUES.MARKETING,
  [JOB_TYPES.MARKETING_CAMPAIGN_DISPATCH]: QUEUES.MARKETING,
  [JOB_TYPES.MARKETING_RECIPIENT_BATCH]: QUEUES.MARKETING,
  [JOB_TYPES.MARKETING_DRIP_STEP]: QUEUES.MARKETING,
  [JOB_TYPES.SEGMENTS_REFRESH_LOCATION]: QUEUES.SEGMENTS,
  [JOB_TYPES.SEGMENT_REFRESH]: QUEUES.SEGMENTS,
};

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

function queueForJobType(jobType) {
  return JOB_QUEUE[jobType] || "general";
}

async function enqueueJob({ jobType, locationId = null, payload = {}, priority = 50, runAt = null, maxAttempts = 3, queueName = null, dedupeKey = null }) {
  const models = getModels();
  const job = await models.CrmQueueJob.create({
    queueName: queueName || queueForJobType(jobType),
    jobType,
    locationId,
    payload,
    priority,
    runAt: runAt || new Date(),
    maxAttempts,
    dedupeKey,
  });
  return plain(job);
}

async function scheduleUniqueJob({ dedupeKey, ...input }) {
  if (!dedupeKey) throw new Error("dedupeKey is required for a unique scheduled job");
  const models = getModels();
  const values = {
    queueName: input.queueName || queueForJobType(input.jobType),
    jobType: input.jobType,
    locationId: input.locationId || null,
    payload: input.payload || {},
    priority: input.priority || 50,
    runAt: input.runAt || new Date(),
    maxAttempts: input.maxAttempts || 3,
    status: "pending",
    attempts: 0,
    result: {},
    completedAt: null,
    startedAt: null,
    lockedAt: null,
    lockedBy: null,
    lastError: null,
  };
  const existing = await models.CrmQueueJob.findOne({ where: { dedupeKey } });
  if (existing) return plain(await existing.update(values));
  try {
    return plain(await models.CrmQueueJob.create({ ...values, dedupeKey }));
  } catch (error) {
    // A concurrent scheduler may win the unique insert. Update the winner so
    // the latest requested time/payload remains authoritative.
    if (error?.name !== "SequelizeUniqueConstraintError") throw error;
    const winner = await models.CrmQueueJob.findOne({ where: { dedupeKey } });
    if (!winner) throw error;
    return plain(await winner.update(values));
  }
}

async function enqueueAutomationEvents(events = [], defaults = {}) {
  const jobs = [];
  for (const event of events.filter(Boolean)) {
    if (!event.eventType && !event.triggerKey) continue;
    jobs.push(await enqueueJob({
      jobType: JOB_TYPES.AUTOMATION_EVENT,
      locationId: event.locationId || defaults.locationId || null,
      priority: defaults.priority || 40,
      payload: {
        event: {
          ...event,
          locationId: event.locationId || defaults.locationId,
          source: event.source || defaults.source || "crm",
        },
      },
    }));
  }
  return { queued: jobs.length, jobIds: jobs.map((job) => job.id) };
}

async function enqueueSegmentRefreshForLocation(locationId, payload = {}) {
  if (!locationId) return { queued: 0, jobIds: [] };
  const job = await enqueueJob({
    jobType: JOB_TYPES.SEGMENTS_REFRESH_LOCATION,
    locationId,
    priority: 60,
    payload,
  });
  return { queued: 1, jobIds: [job.id] };
}

async function enqueueSegmentRefresh(segmentId, locationId, payload = {}) {
  if (!segmentId || !locationId) return { queued: 0, jobIds: [] };
  const job = await enqueueJob({
    jobType: JOB_TYPES.SEGMENT_REFRESH,
    locationId,
    priority: 55,
    payload: { ...payload, segmentId },
  });
  return { queued: 1, jobIds: [job.id] };
}

async function claimPendingJobs({ workerId, queueName, limit = 10 } = {}) {
  const models = getModels();
  await models.CrmQueueJob.update(
    { status: "pending", lockedAt: null, lockedBy: null, lastError: "Recovered after a stale worker lock." },
    {
      where: {
        queueName,
        status: "processing",
        lockedAt: { [Op.lte]: new Date(Date.now() - config.queueJobs.staleLockMs) },
      },
    }
  );
  const rows = await models.CrmQueueJob.findAll({
    where: {
      queueName,
      status: "pending",
      runAt: { [Op.lte]: new Date() },
    },
    order: [["priority", "ASC"], ["createdAt", "ASC"]],
    limit,
  });

  const claimed = [];
  for (const row of rows) {
    const [updated] = await models.CrmQueueJob.update(
      {
        status: "processing",
        lockedAt: new Date(),
        lockedBy: workerId,
        startedAt: row.startedAt || new Date(),
        attempts: Number(row.attempts || 0) + 1,
      },
      { where: { id: row.id, status: "pending" } }
    );
    if (!updated) continue;
    const fresh = await models.CrmQueueJob.findByPk(row.id);
    if (fresh) claimed.push(fresh);
  }
  return claimed;
}

async function completeJob(job, result = {}) {
  return job.update({
    status: "completed",
    result,
    completedAt: new Date(),
    lockedAt: null,
    lockedBy: null,
    lastError: null,
  });
}

async function failJob(job, err) {
  const attempts = Number(job.attempts || 0);
  const maxAttempts = Number(job.maxAttempts || 3);
  const retry = attempts < maxAttempts;
  const updated = await job.update({
    status: retry ? "pending" : "failed",
    runAt: retry ? new Date(Date.now() + Math.min(60000, 1000 * 2 ** attempts)) : job.runAt,
    completedAt: retry ? null : new Date(),
    lockedAt: null,
    lockedBy: null,
    lastError: err?.message || String(err || "Unknown queue job error"),
  });
  if (!retry) {
    const models = getModels();
    try {
      await models.CrmAuditLog.create({
        locationId: job.locationId || null,
        action: "queue_job_retry_exhausted",
        entityType: "system",
        entityId: String(job.id),
        entityName: job.jobType,
        outcome: "failure",
        metadata: {
          queueName: job.queueName,
          jobType: job.jobType,
          attempts,
          maxAttempts,
          error: err?.message || String(err || "Unknown queue job error"),
          escalationRequired: true,
        },
      });
    } catch (_auditError) {
      // A terminal job failure must still be persisted if audit storage is unavailable.
    }
  }
  return updated;
}

module.exports = {
  JOB_TYPES,
  QUEUES,
  claimPendingJobs,
  completeJob,
  enqueueAutomationEvents,
  enqueueJob,
  enqueueSegmentRefresh,
  enqueueSegmentRefreshForLocation,
  failJob,
  scheduleUniqueJob,
};
