const test = require("node:test");
const assert = require("node:assert/strict");
const metaProvider = require("../src/modules/conversations/metaMessagingProvider");
const { _internal: outbound } = require("../src/modules/conversations/outboundService");

test("Meta sender keeps access tokens out of URLs and sends RESPONSE text", async () => {
  let captured;
  const result = await metaProvider.sendText({
    externalAccountId: "page-1", recipientId: "person-1", text: "How can we help?", accessToken: "secret-token",
  }, async (url, options) => {
    captured = { url, options };
    return { ok: true, status: 200, json: async () => ({ recipient_id: "person-1", message_id: "mid.sent-1" }) };
  });
  assert.equal(captured.url.includes("secret-token"), false);
  assert.equal(captured.options.headers.Authorization, "Bearer secret-token");
  assert.deepEqual(JSON.parse(captured.options.body), {
    recipient: { id: "person-1" }, messaging_type: "RESPONSE", message: { text: "How can we help?" },
  });
  assert.equal(result.providerMessageId, "mid.sent-1");
});

test("Meta rate limits are retryable while policy rejection is permanent", async () => {
  await assert.rejects(
    () => metaProvider.sendText({ externalAccountId: "page", recipientId: "person", text: "Hello", accessToken: "token" },
      async () => ({ ok: false, status: 429, json: async () => ({ error: { code: 613 } }) })),
    (error) => error.retryable === true && error.code === "meta_send_retryable"
  );
  await assert.rejects(
    () => metaProvider.sendText({ externalAccountId: "page", recipientId: "person", text: "Hello", accessToken: "token" },
      async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 10 } }) })),
    (error) => error.retryable === false && error.code === "meta_send_rejected"
  );
});

test("reply validation blocks disconnected channels and expired windows", () => {
  const openConversation = { externalThreadId: "person", replyWindowClosesAt: "2026-10-03T10:00:00Z" };
  const connected = { status: "connected", capabilities: { sendMessages: true } };
  assert.doesNotThrow(() => outbound.validateReply(openConversation, connected, new Date("2026-10-02T10:00:00Z")));
  assert.throws(() => outbound.validateReply(openConversation, { status: "error", capabilities: {} }), (error) => error.code === "channel_not_connected");
  assert.throws(
    () => outbound.validateReply({ ...openConversation, replyWindowClosesAt: "2026-10-02T09:00:00Z" }, connected, new Date("2026-10-02T10:00:00Z")),
    (error) => error.code === "reply_window_closed"
  );
});

test("Instagram replies use the linked Facebook Page endpoint", () => {
  assert.equal(
    outbound.metaSenderAccountId({ channel: "instagram", externalAccountId: "ig-1" }, { parentPageId: "page-1" }),
    "page-1"
  );
  assert.equal(
    outbound.metaSenderAccountId({ channel: "facebook", externalAccountId: "page-2" }, {}),
    "page-2"
  );
  assert.throws(
    () => outbound.metaSenderAccountId({ channel: "instagram", externalAccountId: "ig-1" }, {}),
    (error) => error.code === "instagram_parent_page_missing"
  );
});

test("retry backoff is exponential, bounded, and supports jitter", () => {
  assert.equal(outbound.retryDelayMs(1, () => 0), 2000);
  assert.equal(outbound.retryDelayMs(2, () => 0), 4000);
  assert.equal(outbound.retryDelayMs(99, () => 0), 15 * 60 * 1000);
  assert.equal(outbound.retryDelayMs(1, () => 1), 2400);
});

test("event feed cursors round-trip and invalid values fail safely", () => {
  const row = { id: "8c44ee17-b9dd-4e91-8799-3c9425df44ab", createdAt: new Date("2026-10-02T10:00:00Z") };
  const encoded = outbound.encodeEventCursor(row);
  assert.deepEqual(outbound.decodeEventCursor(encoded), { id: row.id, at: row.createdAt });
  assert.throws(() => outbound.decodeEventCursor("broken"), (error) => error.code === "invalid_event_cursor");
});

test("outbound requests require a stable idempotency key", () => {
  assert.equal(outbound.normalizeIdempotencyKey("reply:conversation-1:client-1"), "reply:conversation-1:client-1");
  assert.throws(() => outbound.normalizeIdempotencyKey(""), (error) => error.code === "idempotency_key_required");
  assert.throws(() => outbound.normalizeIdempotencyKey("contains spaces"), (error) => error.code === "invalid_idempotency_key");
});
