const test = require("node:test");
const assert = require("node:assert/strict");

const warmupService = require("../src/modules/messaging-core/warmup/senderWarmupService");

test("sender warmup exposes the complete customer-facing sending plan", () => {
  assert.deepEqual(warmupService.getWarmupPlan(), [
    { stage: 1, dailyLimit: 50, hourlyLimit: 10 },
    { stage: 2, dailyLimit: 100, hourlyLimit: 20 },
    { stage: 3, dailyLimit: 200, hourlyLimit: 40 },
    { stage: 4, dailyLimit: 400, hourlyLimit: 80 },
    { stage: 5, dailyLimit: 800, hourlyLimit: 160 },
    { stage: 6, dailyLimit: 1500, hourlyLimit: 300 },
    { stage: 7, dailyLimit: 2500, hourlyLimit: 500 },
    { stage: 8, dailyLimit: 4000, hourlyLimit: 800 },
    { stage: 9, dailyLimit: 6000, hourlyLimit: 1200 },
    { stage: 10, dailyLimit: 10000, hourlyLimit: 2000 },
  ]);
});

test("shared Movira SES keeps a tenant allowance after warmup", () => {
  assert.deepEqual(warmupService.getPostWarmupPolicy("movira_ses"), {
    mode: "shared_movira_allowance",
    quotaScope: "location",
    dailyLimit: 10000,
    hourlyLimit: 2000,
    customProviderRecommendedAboveDaily: 10000,
  });
});

test("customer-owned providers use their own quota after warmup", () => {
  assert.deepEqual(warmupService.getPostWarmupPolicy("customer_ses"), {
    mode: "customer_provider_quota",
    quotaScope: "provider_account",
    dailyLimit: null,
    hourlyLimit: null,
    customProviderRecommendedAboveDaily: null,
  });
});

test("shared Movira allowance supports safe per-location plan overrides", () => {
  const previous = process.env.CRM_LOCATION_EMAIL_LIMITS;
  process.env.CRM_LOCATION_EMAIL_LIMITS = JSON.stringify({
    default: { dailyLimit: 12000, hourlyLimit: 2200 },
    51: { dailyLimit: 50000, hourlyLimit: 7000 },
  });
  try {
    assert.deepEqual(warmupService.sharedMoviraAllowance(51), { dailyLimit: 50000, hourlyLimit: 7000 });
    assert.deepEqual(warmupService.sharedMoviraAllowance(99), { dailyLimit: 12000, hourlyLimit: 2200 });
    assert.equal(warmupService.getPostWarmupPolicy("movira_ses", 51).dailyLimit, 50000);
  } finally {
    if (previous === undefined) delete process.env.CRM_LOCATION_EMAIL_LIMITS;
    else process.env.CRM_LOCATION_EMAIL_LIMITS = previous;
  }
});
