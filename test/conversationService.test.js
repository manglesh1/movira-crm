const test = require("node:test");
const assert = require("node:assert/strict");
const { _internal } = require("../src/modules/conversations/service");

test("conversation cursor round-trips without exposing database ordering details", () => {
  const row = { id: "7ea87ac0-0a8f-477d-a99f-a1cda8fb2fea", lastMessageAt: new Date("2026-10-02T09:30:00.000Z") };
  const cursor = _internal.encodeCursor(row);
  assert.equal(cursor.includes("2026"), false);
  assert.deepEqual(_internal.decodeCursor(cursor), { id: row.id, at: row.lastMessageAt });
});

test("invalid cursor is rejected with a client-safe error", () => {
  assert.throws(() => _internal.decodeCursor("not-a-cursor"), (error) => {
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "invalid_cursor");
    return true;
  });
});

test("reply capability requires a connected provider and an open reply window", () => {
  const now = new Date("2026-10-02T10:00:00.000Z");
  assert.equal(_internal.conversationCapabilities({}, { status: "connected", capabilities: { sendMessages: true } }, now).canReply, true);

  const expired = _internal.conversationCapabilities(
    { replyWindowClosesAt: "2026-10-02T09:59:59.000Z" },
    { status: "connected", capabilities: { sendMessages: true } },
    now
  );
  assert.equal(expired.canReply, false);
  assert.equal(expired.replyBlockedReason, "reply_window_closed");

  const disconnected = _internal.conversationCapabilities({}, { status: "error" }, now);
  assert.equal(disconnected.canReply, false);
  assert.equal(disconnected.replyBlockedReason, "channel_not_connected");
});

test("channel catalog distinguishes usable, planned, and restricted providers", () => {
  const availability = Object.fromEntries(_internal.CHANNEL_CATALOG.map((item) => [item.channel, item.availability]));
  assert.equal(availability.facebook, "available");
  assert.equal(availability.instagram, "available");
  assert.equal(availability.email, "available");
  assert.equal(availability.whatsapp, "planned");
  assert.equal(availability.linkedin, "restricted");
});

test("location scope accepts only positive integer ids", () => {
  assert.equal(_internal.locationId("51"), 51);
  assert.throws(() => _internal.locationId(""), /locationId is required/);
  assert.throws(() => _internal.locationId("2.5"), /locationId is required/);
});

test("conversation workspace settings are normalized before persistence", () => {
  assert.deepEqual(_internal.cleanRouting({ roundRobin: true, firstResponseMinutes: 30, nextResponseMinutes: 240 }), {
    roundRobin: true,
    skipUnavailable: true,
    fallbackInbox: "Customer care",
    slaEnabled: false,
    firstResponseMinutes: 30,
    nextResponseMinutes: 240,
    escalationInbox: "Manager",
  });
  const preferences = _internal.cleanPreferences({ browser: true, retentionMonths: "12", defaultView: "all" });
  assert.equal(preferences.browser, true);
  assert.equal(preferences.retentionMonths, "12");
  assert.equal(preferences.defaultView, "all");
  assert.equal(preferences.aiReply, false);
});
