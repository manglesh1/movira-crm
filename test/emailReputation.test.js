const test = require("node:test");
const assert = require("node:assert/strict");
const { reputationSummary } = require("../src/modules/settings/email/analyticsService");

test("sender reputation combines delivery risk signals into actionable health", () => {
  const healthy = reputationSummary({ sent: 1000, delivered: 990, failed: 2, counts: { bounced: 5, complained: 0, unsubscribed: 2 } });
  assert.equal(healthy.status, "excellent");
  assert.equal(healthy.deliveryRate, 99);
  assert.match(healthy.recommendations[0], /healthy/i);

  const risky = reputationSummary({ sent: 1000, delivered: 850, failed: 50, counts: { bounced: 50, complained: 3, unsubscribed: 20 } });
  assert.equal(risky.status, "critical");
  assert.ok(risky.recommendations.some((item) => /complaint/i.test(item)));
  assert.ok(risky.recommendations.some((item) => /invalid addresses/i.test(item)));
});

test("sender reputation reports no-data guidance before the first send", () => {
  const result = reputationSummary({ sent: 0, delivered: 0, failed: 0, counts: {} });
  assert.equal(result.score, null);
  assert.equal(result.status, "no_data");
  assert.ok(result.recommendations.length);
});
