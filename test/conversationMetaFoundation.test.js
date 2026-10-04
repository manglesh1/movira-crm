const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { Op } = require("sequelize");
const config = require("../src/config");
const vault = require("../src/shared/credentialVault");
const { _internal: oauth } = require("../src/modules/conversations/metaOAuthService");
const { _internal: webhook } = require("../src/modules/conversations/metaWebhookService");
const { _internal: webhookAuth } = require("../src/shared/webhookAuth");

test("provider credentials are encrypted and authenticated at rest", () => {
  const secret = { accessToken: "never-return-this-token", parentPageId: "42" };
  const encrypted = vault.encryptJson(secret);
  assert.equal(encrypted.includes(secret.accessToken), false);
  assert.deepEqual(vault.decryptJson(encrypted), secret);
  const parts = encrypted.split(".");
  parts[3] = `${parts[3][0] === "A" ? "B" : "A"}${parts[3].slice(1)}`;
  const tampered = parts.join(".");
  assert.throws(() => vault.decryptJson(tampered));
});

test("Meta account discovery separates safe UI data from access tokens", () => {
  const result = oauth.discoveredAccounts([{
    id: "page-1", name: "Movira Park", access_token: "page-secret",
    instagram_business_account: { id: "ig-1", username: "movirapark" },
  }]);
  assert.equal(result.safeAccounts.length, 2);
  assert.equal(JSON.stringify(result.safeAccounts).includes("page-secret"), false);
  assert.equal(result.privateAccounts[1].accessToken, "page-secret");
  assert.equal(result.safeAccounts[1].accountKey, "instagram:ig-1");
});

test("Meta subscriptions use the linked Facebook Page for Instagram accounts", () => {
  assert.deepEqual(oauth.subscriptionForAccount({
    channel: "facebook", externalAccountId: "page-1",
  }), {
    targetId: "page-1",
    fields: "messages,messaging_postbacks,message_deliveries,message_reads",
  });
  assert.deepEqual(oauth.subscriptionForAccount({
    channel: "instagram", externalAccountId: "ig-1", parentPageId: "page-1",
  }), {
    targetId: "page-1",
    fields: "messages,messaging_postbacks,message_deliveries,message_reads",
  });
  assert.throws(
    () => oauth.subscriptionForAccount({ channel: "instagram", externalAccountId: "ig-1" }),
    (error) => error.code === "meta_instagram_page_required"
  );
});

test("disconnected ownership history does not block another location", () => {
  const where = oauth.activeAccountOwnershipWhere({
    channel: "instagram", externalAccountId: "ig-1",
  }, 22);
  assert.equal(where.channel, "instagram");
  assert.equal(where.provider, "meta");
  assert.equal(where.externalAccountId, "ig-1");
  assert.equal(where.locationId[Op.ne], 22);
  assert.equal(where.status[Op.ne], "disconnected");
});

test("Meta sender profiles are normalized for Facebook and Instagram inbox identities", () => {
  assert.equal(webhook.profileFields("facebook"), "id,name,first_name,last_name,profile_pic");
  assert.equal(webhook.profileFields("instagram"), "id,name,username,profile_pic");
  assert.deepEqual(webhook.normalizedProfile("facebook", {
    first_name: "Yogesh", last_name: "Niranjan", profile_pic: "https://cdn.example/fb.jpg",
  }), {
    displayName: "Yogesh Niranjan",
    handle: null,
    avatarUrlCached: "https://cdn.example/fb.jpg",
    profileMetadataSafe: { firstName: "Yogesh", lastName: "Niranjan", profileSource: "meta_graph", channel: "facebook" },
  });
  assert.deepEqual(webhook.normalizedProfile("instagram", {
    name: "Hema Kids", username: "hemakidstoon", profile_pic: "https://cdn.example/ig.jpg",
  }), {
    displayName: "Hema Kids",
    handle: "hemakidstoon",
    avatarUrlCached: "https://cdn.example/ig.jpg",
    profileMetadataSafe: { profileSource: "meta_graph", channel: "instagram" },
  });
});

test("Meta webhook signature is verified against the exact raw request body", () => {
  const previous = config.integrations.meta.appSecret;
  config.integrations.meta.appSecret = "meta-test-secret";
  try {
    const rawBody = Buffer.from('{"entry":[{"id":"page-1"}]}');
    const signature = `sha256=${crypto.createHmac("sha256", "meta-test-secret").update(rawBody).digest("hex")}`;
    assert.equal(webhookAuth.verifyMeta({ rawBody, body: {}, headers: { "x-hub-signature-256": signature } }), true);
    assert.equal(webhookAuth.verifyMeta({ rawBody: Buffer.from("changed"), body: {}, headers: { "x-hub-signature-256": signature } }), false);
  } finally {
    config.integrations.meta.appSecret = previous;
  }
});

test("Meta inbound event normalization keeps supported content and stable idempotency ids", () => {
  const event = {
    sender: { id: "person-1" }, recipient: { id: "page-1" }, timestamp: 1790935200000,
    message: { mid: "mid.123", text: "Need help", attachments: [{ type: "image", payload: { url: "https://cdn.example/image.jpg", ignored: "x" } }] },
  };
  assert.equal(webhook.eventId("page-1", event), "message:mid.123");
  assert.deepEqual(webhook.safePayload(event).message.attachments, [{ type: "image", url: "https://cdn.example/image.jpg", stickerId: null }]);
  assert.equal(webhook.plusHours(new Date("2026-10-02T10:00:00Z"), 24).toISOString(), "2026-10-03T10:00:00.000Z");
});

test("Instagram seen receipts retain the provider message id", () => {
  const event = {
    sender: { id: "ig-person-1" }, recipient: { id: "ig-business-1" }, timestamp: 1790935200000,
    read: { mid: "ig-mid.123" },
  };
  assert.deepEqual(webhook.safePayload(event).read, { mid: "ig-mid.123", watermark: null });
});
