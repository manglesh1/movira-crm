const test = require("node:test");
const assert = require("node:assert/strict");
const { _internal } = require("../src/modules/marketing/email/rssCampaignService");

test("RSS and Atom items normalize into stable campaign merge data", () => {
  const rss = _internal.parseFeed(`<?xml version="1.0"?><rss><channel><title>Movira News</title><item><guid>post-2</guid><title><![CDATA[Launch <b>update</b>]]></title><link>https://example.com/post-2</link><description><![CDATA[<p>What changed</p>]]></description><pubDate>Fri, 02 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`);
  assert.equal(rss.title, "Movira News");
  assert.equal(rss.items[0].title, "Launch update");
  assert.equal(rss.items[0].description, "What changed");
  assert.equal(rss.items[0].fingerprint.length, 64);
  assert.equal(_internal.interpolate("New: {{rss.title}}", rss.items[0]), "New: Launch update");
});

test("RSS URL and IP checks reject unsafe destinations", () => {
  assert.equal(_internal.safeFeedUrl("https://example.com/feed.xml").protocol, "https:");
  assert.throws(() => _internal.safeFeedUrl("file:///etc/passwd"), /public HTTP or HTTPS/i);
  assert.equal(_internal.privateIp("127.0.0.1"), true);
  assert.equal(_internal.privateIp("10.20.30.40"), true);
  assert.equal(_internal.privateIp("8.8.8.8"), false);
  assert.equal(_internal.privateIp("::1"), true);
});

test("RSS parsing fails closed when a document has no feed items", () => {
  assert.throws(() => _internal.parseFeed("<rss><channel><title>Empty</title></channel></rss>"), /No RSS or Atom items/i);
});
