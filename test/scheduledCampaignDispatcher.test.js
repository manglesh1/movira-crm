const test = require("node:test");
const assert = require("node:assert/strict");
const queueJobs = require("../src/modules/queueJobs/service");

test("scheduled campaign dispatch has a dedicated durable marketing job type", () => {
  assert.equal(queueJobs.JOB_TYPES.MARKETING_CAMPAIGN_DISPATCH, "marketing.campaign_dispatch");
  assert.equal(queueJobs.QUEUES.MARKETING, "marketing");
});

test("unique scheduler requires an idempotency key", async () => {
  await assert.rejects(
    queueJobs.scheduleUniqueJob({ jobType: queueJobs.JOB_TYPES.MARKETING_CAMPAIGN_DISPATCH }),
    /dedupeKey is required/
  );
});
