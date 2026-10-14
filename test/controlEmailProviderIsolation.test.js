const assert = require("node:assert/strict");
const test = require("node:test");

const router = require("../src/modules/messaging-core/providers/emailProviderRouter");
const moviraSesProvider = require("../src/modules/messaging-core/providers/sesEmailProvider");
const domainSenderResolver = require("../src/modules/messaging-core/providers/domainSenderResolver");
const emailDeliveryPolicy = require("../src/shared/emailDeliveryPolicy");

test("Movira Control email bypasses location toggles, domains and customer providers", async (t) => {
  let sent = null;
  t.mock.method(emailDeliveryPolicy, "assertEnabled", async () => {
    throw new Error("location delivery policy must not run");
  });
  t.mock.method(domainSenderResolver, "resolveSender", async () => {
    throw new Error("location sender must not be resolved");
  });
  t.mock.method(moviraSesProvider, "sendTransactionalEmail", async (input) => {
    sent = input;
    return { provider: "movira_ses", providerMessageId: "control-1" };
  });

  const result = await router.sendTransactionalEmail({
    locationId: 52,
    communicationScope: "movira_control",
    sourceEventType: "saas.invoice.issued",
    to: "owner@example.com",
    from: "location-sender@example.com",
    replyTo: "location-replies@example.com",
    bcc: ["location-audit@example.com"],
    subject: "Movira invoice",
    html: "<p>Movira</p>",
  });

  assert.equal(sent.to, "owner@example.com");
  assert.equal(sent.useCase, "transactional");
  assert.equal(sent.from, undefined);
  assert.equal(sent.replyTo, undefined);
  assert.equal(sent.bcc, undefined);
  assert.equal(result.provider, "movira_ses");
});
