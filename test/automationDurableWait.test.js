const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("../src/modules/automation/engine");
const queueJobs = require("../src/modules/queueJobs/service");
const { automationBatching } = require("../src/modules/automation/service");

test("automation wait returns a durable continuation instead of running later steps", async () => {
  const workflow = {
    locationId: 1,
    nodes: [
      { id: "wait-1", type: "wait", actionId: "wait", config: { amount: 2, unit: "hours" } },
      { id: "sms-1", type: "action", actionId: "send_sms", config: {} },
    ],
  };
  const result = await engine.runForContact(workflow, { id: "contact-1" });

  assert.equal(result.status, "waiting");
  assert.equal(result.currentNodeId, "wait-1");
  assert.equal(result.remainingNodes.length, 1);
  assert.equal(result.remainingNodes[0].id, "sms-1");
  assert.ok(new Date(result.resumeAt).getTime() > Date.now());
});

test("automation wait duration is bounded and normalized", () => {
  assert.equal(engine.durationMs(2, "minutes"), 120000);
  assert.equal(engine.durationMs(2, "hours"), 7200000);
  assert.equal(engine.durationMs(2, "days"), 172800000);
  assert.equal(engine.durationMs(0, "minutes"), 60000);
});

test("automation resume jobs use the automation queue", () => {
  assert.equal(queueJobs.JOB_TYPES.AUTOMATION_RESUME, "automation.resume");
});

test("automation batching is safe by default and bounds customer settings", () => {
  assert.deepEqual(automationBatching({}), { enabled: true, batchSize: 100, intervalMinutes: 1 });
  assert.deepEqual(automationBatching({ batching: { enabled: false, batchSize: 5000, intervalMinutes: -3 } }), {
    enabled: false,
    batchSize: 1000,
    intervalMinutes: 0,
  });
});
