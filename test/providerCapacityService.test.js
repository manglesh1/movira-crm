const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ProviderCapacityError,
  computeDecision,
  normalizeQuota,
} = require("../src/modules/messaging-core/capacity/providerCapacityService");

const options = {
  snapshotTtlSeconds: 60,
  transactionalReservePercent: 20,
  safetyMarginPercent: 5,
};

function state(overrides = {}) {
  return {
    max24HourSend: 1000,
    maxSendRate: 100,
    observedSentLast24Hours: 0,
    unobservedAccepted: 0,
    reservedTransactional: 0,
    reservedMarketing: 0,
    rateWindowUsed: 0,
    ...overrides,
  };
}

test("marketing stops before transactional reserved capacity is consumed", () => {
  const marketing = computeDecision(state({ observedSentLast24Hours: 760 }), "marketing", options);
  const transactional = computeDecision(state({ observedSentLast24Hours: 760 }), "transactional", options);

  assert.equal(marketing.allowed, false);
  assert.equal(marketing.dailyLimit, 760);
  assert.equal(transactional.allowed, true);
  assert.equal(transactional.dailyLimit, 950);
});

test("pending reservations participate in the global atomic capacity decision", () => {
  const decision = computeDecision(state({
    observedSentLast24Hours: 900,
    reservedTransactional: 25,
    reservedMarketing: 25,
  }), "transactional", options);

  assert.equal(decision.allowed, false);
  assert.equal(decision.used, 950);
});

test("marketing has a protected per-second transactional reserve", () => {
  const marketing = computeDecision(state({ rateWindowUsed: 76 }), "marketing", options);
  const transactional = computeDecision(state({ rateWindowUsed: 76 }), "transactional", options);

  assert.equal(marketing.allowed, false);
  assert.equal(transactional.allowed, true);
});

test("invalid or sandbox-disabled SES quota fails closed", () => {
  assert.throws(
    () => normalizeQuota({ Max24HourSend: 0, MaxSendRate: 0, SentLast24Hours: 0 }),
    (error) => error instanceof ProviderCapacityError && error.code === "PROVIDER_QUOTA_UNAVAILABLE"
  );
});

test("SES quota values are normalized for capacity storage", () => {
  const quota = normalizeQuota({ Max24HourSend: 50000, MaxSendRate: 14.5, SentLast24Hours: 1200 });
  assert.equal(quota.max24HourSend, 50000);
  assert.equal(quota.maxSendRate, 14.5);
  assert.equal(quota.sentLast24Hours, 1200);
  assert.ok(quota.fetchedAt instanceof Date);
});
