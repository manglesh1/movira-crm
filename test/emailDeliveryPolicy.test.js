const test = require("node:test");
const assert = require("node:assert/strict");

const policy = require("../src/shared/emailDeliveryPolicy");

test.afterEach(() => {
  policy._clearCache();
});

test("location email controls fail closed for disabled transactional and marketing delivery", async (t) => {
  t.mock.method(global, "fetch", async () => ({
    ok: true,
    json: async () => ({
      data: {
        transactionalEmailEnabled: false,
        marketingEmailEnabled: false,
      },
    }),
  }));

  await assert.rejects(
    policy.assertEnabled("transactional", { locationId: 52 }, { fresh: true }),
    (error) => error.code === "transactional_email_disabled" && error.statusCode === 409
  );
  await assert.rejects(
    policy.assertEnabled("marketing", { locationId: 52 }, { fresh: true }),
    (error) => error.code === "marketing_email_disabled" && error.statusCode === 409
  );
});

test("Movira Control SaaS email bypasses location transactional controls", async (t) => {
  const fetchMock = t.mock.method(global, "fetch", async () => {
    throw new Error("policy endpoint should not be called");
  });

  await assert.doesNotReject(
    policy.assertEnabled("transactional", {
      locationId: 52,
      sourceEventType: "saas.invoice.issued",
    })
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("Movira Control scoped test email bypasses location transactional controls", async (t) => {
  const fetchMock = t.mock.method(global, "fetch", async () => {
    throw new Error("policy endpoint should not be called");
  });

  await assert.doesNotReject(
    policy.assertEnabled("transactional", {
      locationId: 52,
      sourceEventType: "transactional_template_test_send",
      payload: { templateScope: "movira_control" },
    })
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("enabled location preferences permit matching delivery", async (t) => {
  t.mock.method(global, "fetch", async () => ({
    ok: true,
    json: async () => ({
      data: {
        transactionalEmailEnabled: true,
        marketingEmailEnabled: true,
      },
    }),
  }));

  await assert.doesNotReject(
    policy.assertEnabled("transactional", { locationId: 52 }, { fresh: true })
  );
  await assert.doesNotReject(
    policy.assertEnabled("marketing", { locationId: 52 }, { fresh: true })
  );
});
