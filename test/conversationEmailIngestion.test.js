const test = require("node:test");
const assert = require("node:assert/strict");
const { _internal } = require("../src/modules/conversations/emailIngestionService");

test("inbound email normalization accepts display-name addresses and rejects invalid values", () => {
  assert.equal(_internal.cleanEmail("Customer <Person@Example.COM>"), "person@example.com");
  assert.equal(_internal.cleanEmail("person@example.com"), "person@example.com");
  assert.equal(_internal.cleanEmail("not-an-email"), null);
});

test("email threading is stable for replies and falls back to sender address", () => {
  const first = _internal.threadKey({ inReplyTo: "<message-123@example.com>" }, "person@example.com");
  const second = _internal.threadKey({ inReplyTo: "<message-123@example.com>" }, "person@example.com");
  assert.equal(first, second);
  assert.equal(first.length, 64);
  assert.equal(_internal.threadKey({}, "person@example.com"), "person@example.com");
});

test("inbound HTML is converted to safe readable text", () => {
  assert.equal(_internal.stripHtml("<p>Hello <strong>team</strong></p><script>alert(1)</script>"), "Hello team");
});
