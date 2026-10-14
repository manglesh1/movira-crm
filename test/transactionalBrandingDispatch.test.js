const assert = require("node:assert/strict");
const test = require("node:test");

const dispatcher = require("../src/modules/transactional/dispatcher");
const renderer = require("../src/modules/transactional/templateRenderer");
const emailProvider = require("../src/modules/messaging-core/providers/emailProviderRouter");
const platformBranding = require("../src/shared/platformBranding");

test("transactional test sends render with fresh location white-label branding", async (t) => {
  let renderedMessage = null;
  let brandingOptions = null;

  t.mock.method(platformBranding, "getEmailBranding", async (locationId, options) => {
    assert.equal(locationId, 52);
    brandingOptions = options;
    return {
      emailBrandName: "Yug Water Park",
      emailBrandPrimaryColor: "#0F766E",
      moviraLogoUrl: "https://example.com/yug-logo.png",
    };
  });
  t.mock.method(renderer, "renderTransactionalMessage", async (message) => {
    renderedMessage = message;
    return {
      subject: "White-label test",
      body: "<p>Yug Water Park</p>",
      text: "Yug Water Park",
      template: { config: {} },
    };
  });
  t.mock.method(emailProvider, "sendTransactionalEmail", async (input) => input);

  await dispatcher.dispatch({
    id: 10,
    locationId: 52,
    channel: "email",
    recipientAddress: "owner@example.com",
    payload: {
      emailBrandPrimaryColor: "#7220E6",
      __test: { requestedSubject: "Test subject" },
    },
    attachments: [],
  });

  assert.equal(brandingOptions.fresh, true);
  assert.equal(renderedMessage.payload.emailBrandName, "Yug Water Park");
  assert.equal(renderedMessage.payload.emailBrandPrimaryColor, "#0F766E");
  assert.equal(renderedMessage.payload.moviraLogoUrl, "https://example.com/yug-logo.png");
});

test("Sequelize message getters survive branding before template resolution", async (t) => {
  let renderedMessage = null;
  const dataValues = {
    id: 12,
    locationId: 52,
    channel: "email",
    recipientAddress: "owner@example.com",
    payload: { __test: { requestedSubject: "Test" } },
    attachments: [],
  };
  const sequelizeLikeMessage = {
    dataValues,
    get(options) {
      assert.deepEqual(options, { plain: true });
      return { ...dataValues };
    },
  };
  for (const key of Object.keys(dataValues)) {
    Object.defineProperty(sequelizeLikeMessage, key, {
      enumerable: false,
      get: () => dataValues[key],
    });
  }

  t.mock.method(platformBranding, "getEmailBranding", async () => ({
    emailBrandPrimaryColor: "#0F766E",
  }));
  t.mock.method(renderer, "renderTransactionalMessage", async (message) => {
    renderedMessage = message;
    return {
      subject: "Test",
      body: "<p>Test</p>",
      text: "Test",
      template: { config: {} },
    };
  });
  t.mock.method(emailProvider, "sendTransactionalEmail", async (input) => input);

  await dispatcher.dispatch(sequelizeLikeMessage);

  assert.equal(renderedMessage.locationId, 52);
  assert.equal(renderedMessage.recipientAddress, "owner@example.com");
  assert.equal(renderedMessage.payload.emailBrandPrimaryColor, "#0F766E");
});

test("Movira Control sends keep platform branding and never resolve location white-label branding", async (t) => {
  let renderedMessage = null;

  t.mock.method(platformBranding, "getEmailBranding", async () => {
    throw new Error("location branding must not be requested for Control email");
  });
  t.mock.method(platformBranding, "getPlatformBranding", async (options) => {
    assert.equal(options.fresh, true);
    return {
      emailBrandName: "Movira360 Control",
      emailBrandPrimaryColor: "#7220E6",
      supportEmail: "support@movira360.com",
    };
  });
  t.mock.method(renderer, "renderTransactionalMessage", async (message) => {
    renderedMessage = message;
    return {
      subject: "Control test",
      body: "<p>Movira360 Control</p>",
      text: "Movira360 Control",
      template: { config: {} },
    };
  });
  t.mock.method(emailProvider, "sendTransactionalEmail", async (input) => input);

  await dispatcher.dispatch({
    id: 11,
    locationId: 52,
    channel: "email",
    recipientAddress: "owner@example.com",
    sourceEventType: "saas.invoice.issued",
    payload: {
      templateScope: "movira_control",
      emailBrandName: "Yug Water Park",
      emailBrandPrimaryColor: "#12D34C",
      __test: { requestedSubject: "Control test" },
    },
    attachments: [],
  });

  assert.equal(renderedMessage.payload.emailBrandName, "Movira360 Control");
  assert.equal(renderedMessage.payload.emailBrandPrimaryColor, "#7220E6");
  assert.equal(renderedMessage.payload.supportEmail, "support@movira360.com");
});
