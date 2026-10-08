const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET ||= "test-secret";

const webchat = require("../src/modules/conversations/webchatService");

test("web chat settings normalize branding and permitted website origins", () => {
  const settings = webchat._internal.normalizeSettings({
    greeting: " Welcome to the park ",
    launcherLabel: " Help ",
    introText: " Tell us what you need ",
    messagePlaceholder: " Write here ",
    launcherStyle: "text",
    accentColor: "#123abc",
    position: "left",
    allowedOrigins: ["https://example.com/path", "https://example.com", "javascript:alert(1)"],
    nameField: "optional",
    emailField: "required",
    phoneField: "optional",
  });
  assert.equal(settings.greeting, "Welcome to the park");
  assert.equal(settings.launcherLabel, "Help");
  assert.equal(settings.introText, "Tell us what you need");
  assert.equal(settings.messagePlaceholder, "Write here");
  assert.equal(settings.launcherStyle, "text");
  assert.equal(settings.accentColor, "#123abc");
  assert.equal(settings.position, "left");
  assert.deepEqual(settings.allowedOrigins, ["https://example.com"]);
  assert.equal(settings.nameField, "optional");
  assert.equal(settings.emailField, "required");
  assert.equal(settings.phoneField, "optional");
  assert.equal(settings.collectName, true);
  assert.equal(settings.collectEmail, true);
  assert.equal(settings.collectPhone, true);
});

test("web chat visitor data rejects invalid contact details and strips unsafe excess", () => {
  assert.throws(() => webchat._internal.safeVisitor({ email: "not-an-email" }), /valid email/i);
  assert.throws(() => webchat._internal.safeVisitor({ phone: "phone-me" }), /valid phone/i);
  assert.deepEqual(webchat._internal.safeVisitor({ name: "  Maya  ", email: "MAYA@EXAMPLE.COM", phone: "+1 416 555 0123" }), {
    name: "Maya",
    email: "maya@example.com",
    phone: "+14165550123",
    pageUrl: "",
  });
});

test("web chat required visitor fields are enforced on the server", () => {
  const settings = webchat._internal.normalizeSettings({
    nameField: "optional",
    emailField: "required",
    phoneField: "required",
  });
  assert.throws(
    () => webchat._internal.enforceVisitorRequirements(settings, { name: "Maya" }, webchat._internal.safeVisitor({ name: "Maya" })),
    /Email is required/i,
  );
  assert.doesNotThrow(() => webchat._internal.enforceVisitorRequirements(
    settings,
    { name: "Maya", email: "maya@example.com", phone: "+14165550123" },
    webchat._internal.safeVisitor({ name: "Maya", email: "maya@example.com", phone: "+14165550123" }),
  ));
});

test("web chat session tokens are stored as hashes", () => {
  const hash = webchat._internal.tokenHash("secret-session-token");
  assert.equal(hash.length, 64);
  assert.equal(hash.includes("secret-session-token"), false);
});

test("all supported web chat launcher styles are preserved", () => {
  for (const launcherStyle of ["pill", "compact", "bubble", "square", "text", "outline", "status", "tab"]) {
    assert.equal(webchat._internal.normalizeSettings({ launcherStyle }).launcherStyle, launcherStyle);
  }
});
