const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isHealthCheckDue,
  domainHealthCheckIntervalMinutes,
} = require("../src/modules/settings/email/service");

test("email health checks treat missing, invalid, and expired timestamps as due", () => {
  const now = new Date("2026-10-02T12:00:00.000Z");
  assert.equal(isHealthCheckDue(null, 60, now), true);
  assert.equal(isHealthCheckDue("invalid", 60, now), true);
  assert.equal(isHealthCheckDue("2026-10-02T10:59:59.000Z", 60, now), true);
  assert.equal(isHealthCheckDue("2026-10-02T11:30:00.000Z", 60, now), false);
});

test("pending domains are checked more frequently than verified domains", () => {
  const oldPending = process.env.EMAIL_PENDING_DOMAIN_RECHECK_MINUTES;
  const oldVerified = process.env.EMAIL_VERIFIED_DOMAIN_RECHECK_MINUTES;
  delete process.env.EMAIL_PENDING_DOMAIN_RECHECK_MINUTES;
  delete process.env.EMAIL_VERIFIED_DOMAIN_RECHECK_MINUTES;
  try {
    assert.equal(domainHealthCheckIntervalMinutes({ status: "pending_dns" }), 60);
    assert.equal(domainHealthCheckIntervalMinutes({ status: "verification_requested" }), 60);
    assert.equal(domainHealthCheckIntervalMinutes({ status: "verified" }), 1440);
  } finally {
    if (oldPending === undefined) delete process.env.EMAIL_PENDING_DOMAIN_RECHECK_MINUTES;
    else process.env.EMAIL_PENDING_DOMAIN_RECHECK_MINUTES = oldPending;
    if (oldVerified === undefined) delete process.env.EMAIL_VERIFIED_DOMAIN_RECHECK_MINUTES;
    else process.env.EMAIL_VERIFIED_DOMAIN_RECHECK_MINUTES = oldVerified;
  }
});
