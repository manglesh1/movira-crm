const assert = require("node:assert/strict");
const { afterEach, mock, test } = require("node:test");
const {
  SESv2Client,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
} = require("@aws-sdk/client-sesv2");
const { sendWithProviderRow } = require("../src/modules/messaging-core/providers/emailProviderRouter");
const sesIdentityService = require("../src/modules/settings/email/sesIdentityService");
const providerDomainService = require("../src/modules/settings/email/providerDomainService");
const providerEventsService = require("../src/modules/webhooks/providerEventsService");
const sesWebhookService = require("../src/modules/webhooks/sesService");
const marketingTrackingService = require("../src/modules/marketing/tracking/service");
const transactionalTracking = require("../src/modules/transactional/tracking");
const config = require("../src/config");
const { oneClickUnsubscribeHeaders } = require("../src/modules/marketing/email/messageDispatcher");

afterEach(() => {
  mock.restoreAll();
});

function providerRow(provider, encryptedConfig = {}) {
  return {
    id: 42,
    provider,
    domain: "transactional",
    encryptedConfig,
  };
}

const emailInput = {
  to: "guest@example.test",
  from: "sender@example.test",
  subject: "Order confirmed",
  html: "<p>Hello</p>",
  text: "Hello",
  messageId: "msg_tx_123",
  replyTo: "replies@example.test",
  bcc: ["audit@example.test", "ops@example.test"],
  trackingTags: [
    { name: "template_id", value: "tpl_1" },
    { name: "location_id", value: "15" },
  ],
  headers: {
    "List-Unsubscribe": "<https://crm.example.test/m/unsubscribe/msg_tx_123>",
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  },
};

test("marketing messages build RFC 8058 one-click unsubscribe headers", () => {
  const previous = config.urls.trackingBaseUrl;
  config.urls.trackingBaseUrl = "https://crm.example.test";
  try {
    assert.deepEqual(oneClickUnsubscribeHeaders("message-123"), {
      "List-Unsubscribe": "<https://crm.example.test/m/unsubscribe/message-123>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  } finally {
    config.urls.trackingBaseUrl = previous;
  }
});

test("customer SES provider sends transactional metadata tags", async () => {
  let commandInput = null;
  mock.method(SESv2Client.prototype, "send", async (command) => {
    commandInput = command.input;
    return { MessageId: "ses-message-id" };
  });

  const result = await sendWithProviderRow(providerRow("customer_ses", {
    region: "ap-south-1",
    accessKeyId: "AKIA_TEST",
    secretAccessKey: "secret",
    configurationSet: "customer-config-set",
    fromEmail: "ses@example.test",
  }), emailInput, "transactional");

  assert.equal(result.provider, "customer_ses");
  assert.equal(result.providerMessageId, "ses-message-id");
  assert.equal(commandInput.ConfigurationSetName, "customer-config-set");
  assert.equal(commandInput.FromEmailAddress, "sender@example.test");
  assert.deepEqual(commandInput.Destination.BccAddresses, ["audit@example.test", "ops@example.test"]);
  assert.deepEqual(commandInput.ReplyToAddresses, ["replies@example.test"]);
  assert.deepEqual(commandInput.EmailTags, [
    { Name: "domain", Value: "transactional" },
    { Name: "message_id", Value: "msg_tx_123" },
    { Name: "template_id", Value: "tpl_1" },
    { Name: "location_id", Value: "15" },
  ]);
});

function mockSesIdentityProvisioning(seenCommands) {
  let created = false;
  mock.method(SESv2Client.prototype, "send", async (command) => {
    seenCommands.push(command);
    if (command instanceof CreateEmailIdentityCommand) {
      created = true;
      return { IdentityArn: "arn:aws:ses:ca-central-1:123456789012:identity/example.test" };
    }
    if (command instanceof PutEmailIdentityMailFromAttributesCommand) return {};
    if (command instanceof GetEmailIdentityCommand) {
      if (!created) {
        const error = new Error("Identity not found");
        error.name = "NotFoundException";
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return {
        VerifiedForSendingStatus: false,
        DkimAttributes: { Tokens: ["dkim-token"] },
        MailFromAttributes: { MailFromDomain: "email.example.test" },
      };
    }
    throw new Error(`Unexpected SES command: ${command.constructor.name}`);
  });
}

test("Movira SES domain provisioning does not require TagResource permission", async () => {
  const seenCommands = [];
  mockSesIdentityProvisioning(seenCommands);

  await sesIdentityService.createIdentity("example.test");

  const createCommand = seenCommands.find((command) => command instanceof CreateEmailIdentityCommand);
  assert.equal(createCommand.input.EmailIdentity, "example.test");
  assert.equal(Object.hasOwn(createCommand.input, "Tags"), false);
});

test("Movira SES provisioning resumes an identity created by an earlier partial attempt", async () => {
  const seenCommands = [];
  mock.method(SESv2Client.prototype, "send", async (command) => {
    seenCommands.push(command);
    if (command instanceof GetEmailIdentityCommand) {
      return {
        IdentityArn: "arn:aws:ses:ca-central-1:123456789012:identity/example.test",
        VerifiedForSendingStatus: false,
        DkimAttributes: { Tokens: ["existing-token"] },
        MailFromAttributes: { MailFromDomain: "email.example.test" },
      };
    }
    if (command instanceof PutEmailIdentityMailFromAttributesCommand) return {};
    throw new Error(`Unexpected SES command: ${command.constructor.name}`);
  });

  const result = await sesIdentityService.createIdentity("example.test");

  assert.equal(result.providerIdentityName, "example.test");
  assert.equal(
    seenCommands.some((command) => command instanceof CreateEmailIdentityCommand),
    false
  );
});

test("customer SES domain provisioning does not require TagResource permission", async () => {
  const seenCommands = [];
  mockSesIdentityProvisioning(seenCommands);

  await providerDomainService.createDomainIdentity({
    provider: "customer_ses",
    providerConfig: {
      encryptedConfig: {
        region: "ca-central-1",
        accessKeyId: "AKIA_TEST",
        secretAccessKey: "secret",
      },
    },
    domain: "example.test",
  });

  const createCommand = seenCommands.find((command) => command instanceof CreateEmailIdentityCommand);
  assert.equal(createCommand.input.EmailIdentity, "example.test");
  assert.equal(Object.hasOwn(createCommand.input, "Tags"), false);
});

test("SendGrid provider sends custom args used by the Event Webhook", async () => {
  let request = null;
  mock.method(global, "fetch", async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      headers: { get: (name) => (String(name).toLowerCase() === "x-message-id" ? "sendgrid-message-id" : null) },
    };
  });

  const result = await sendWithProviderRow(providerRow("customer_sendgrid", {
    apiKey: "SG.test",
    fromEmail: "sg@example.test",
  }), emailInput, "transactional");

  const body = JSON.parse(request.options.body);
  assert.equal(result.provider, "customer_sendgrid");
  assert.equal(result.providerMessageId, "sendgrid-message-id");
  assert.equal(request.url, "https://api.sendgrid.com/v3/mail/send");
  assert.equal(body.custom_args.domain, "transactional");
  assert.equal(body.custom_args.message_id, "msg_tx_123");
  assert.equal(body.custom_args.template_id, "tpl_1");
  assert.equal(body.personalizations[0].to[0].email, "guest@example.test");
  assert.deepEqual(body.personalizations[0].bcc, [
    { email: "audit@example.test" },
    { email: "ops@example.test" },
  ]);
  assert.deepEqual(body.reply_to, { email: "replies@example.test" });
  assert.equal(body.personalizations[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

test("Mailgun provider sends variables used by Mailgun webhooks", async () => {
  let request = null;
  mock.method(global, "fetch", async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      text: async () => JSON.stringify({ id: "mailgun-message-id" }),
    };
  });

  const result = await sendWithProviderRow(providerRow("customer_mailgun", {
    apiKey: "key-test",
    domain: "mg.example.test",
    region: "us",
    fromEmail: "mailgun@example.test",
  }), emailInput, "transactional");

  const fields = Object.fromEntries(request.options.body.entries());
  assert.equal(result.provider, "customer_mailgun");
  assert.equal(result.providerMessageId, "mailgun-message-id");
  assert.equal(request.url, "https://api.mailgun.net/v3/mg.example.test/messages");
  assert.equal(fields["v:domain"], "transactional");
  assert.equal(fields["v:message_id"], "msg_tx_123");
  assert.equal(fields["v:template_id"], "tpl_1");
  assert.deepEqual(request.options.body.getAll("bcc"), ["audit@example.test", "ops@example.test"]);
  assert.equal(fields["h:Reply-To"], "replies@example.test");
  assert.equal(fields["h:List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

test("Postmark provider sends metadata used by Postmark webhooks", async () => {
  let request = null;
  mock.method(global, "fetch", async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      text: async () => JSON.stringify({ MessageID: "postmark-message-id" }),
    };
  });

  const result = await sendWithProviderRow(providerRow("customer_postmark", {
    serverToken: "server-token",
    fromEmail: "postmark@example.test",
    messageStream: "outbound",
  }), emailInput, "transactional");

  const body = JSON.parse(request.options.body);
  assert.equal(result.provider, "customer_postmark");
  assert.equal(result.providerMessageId, "postmark-message-id");
  assert.equal(request.url, "https://api.postmarkapp.com/email");
  assert.equal(body.MessageStream, "outbound");
  assert.equal(body.Metadata.domain, "transactional");
  assert.equal(body.Metadata.message_id, "msg_tx_123");
  assert.equal(body.Metadata.template_id, "tpl_1");
  assert.equal(body.ReplyTo, "replies@example.test");
  assert.equal(body.Bcc, "audit@example.test,ops@example.test");
  assert.deepEqual(body.Headers.find((header) => header.Name === "List-Unsubscribe-Post"), {
    Name: "List-Unsubscribe-Post",
    Value: "List-Unsubscribe=One-Click",
  });
});

test("SendGrid, Mailgun, and Postmark webhooks route events to transactional and marketing tracking", async () => {
  const transactionalCalls = [];
  const marketingCalls = [];
  mock.method(transactionalTracking, "recordTransactionalProviderEvent", async (payload) => {
    transactionalCalls.push(payload);
    return { matched: true, messageId: payload.taggedMessageId, eventType: payload.eventType };
  });
  mock.method(marketingTrackingService, "recordMarketingEvent", async (...args) => {
    marketingCalls.push(args);
    return { messageId: args[0], eventType: args[1] };
  });

  await providerEventsService.handleSendgridWebhook([
    {
      event: "delivered",
      domain: "transactional",
      message_id: "tx_sendgrid",
      sg_message_id: "sg_provider_id",
    },
    {
      event: "click",
      domain: "marketing",
      message_id: "mk_sendgrid",
      sg_message_id: "sg_provider_id_2",
    },
  ]);
  await providerEventsService.handleMailgunWebhook({
    "event-data": {
      event: "failed",
      id: "mg_provider_id",
      "user-variables": {
        domain: "transactional",
        message_id: "tx_mailgun",
      },
    },
  });
  await providerEventsService.handlePostmarkWebhook({
    RecordType: "Bounce",
    MessageID: "pm_provider_id",
    Metadata: {
      domain: "transactional",
      message_id: "tx_postmark",
    },
  });

  assert.equal(transactionalCalls.length, 3);
  assert.deepEqual(transactionalCalls.map((call) => call.provider), ["sendgrid", "mailgun", "postmark"]);
  assert.deepEqual(transactionalCalls.map((call) => call.eventType), ["delivered", "bounce", "bounce"]);
  assert.deepEqual(transactionalCalls.map((call) => call.taggedMessageId), ["tx_sendgrid", "tx_mailgun", "tx_postmark"]);

  assert.equal(marketingCalls.length, 1);
  assert.equal(marketingCalls[0][0], "mk_sendgrid");
  assert.equal(marketingCalls[0][1], "click");
  assert.equal(marketingCalls[0][2].source, "sendgrid_webhook");
});

test("SES webhook routes tagged transactional and marketing events", async () => {
  const transactionalCalls = [];
  const marketingCalls = [];
  mock.method(transactionalTracking, "recordTransactionalSesEvent", async (payload) => {
    transactionalCalls.push(payload);
    return { matched: true, messageId: payload.taggedMessageId, eventType: payload.eventType };
  });
  mock.method(marketingTrackingService, "recordSesEvent", async (payload) => {
    marketingCalls.push(payload);
    return { messageId: "mk_ses", eventType: "delivered" };
  });

  const transactionalResult = await sesWebhookService.handleSesWebhook({
    eventType: "Delivery",
    mail: {
      messageId: "ses_provider_tx",
      tags: {
        domain: ["transactional"],
        message_id: ["tx_ses"],
      },
    },
  });
  const marketingResult = await sesWebhookService.handleSesWebhook({
    eventType: "Delivery",
    mail: {
      messageId: "ses_provider_mk",
      tags: {
        domain: ["marketing"],
        message_id: ["mk_ses"],
      },
    },
  });

  assert.equal(transactionalResult.domain, "transactional");
  assert.equal(transactionalCalls[0].eventType, "delivered");
  assert.equal(transactionalCalls[0].taggedMessageId, "tx_ses");
  assert.equal(marketingResult.domain, "marketing");
  assert.equal(marketingCalls.length, 1);
});
