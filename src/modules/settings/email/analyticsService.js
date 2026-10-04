// Email Analytics + Bounce Classification.
//
// Both aggregate the same underlying tables that the messaging-core writes
// when sending and processing webhook events:
//   crm_transactional_messages         (one row per send attempt)
//   crm_transactional_delivery_events  (one row per provider event)
//
// Until the messaging-core is fully wired the tables may be empty, in which
// case the endpoints return zeroed metrics — UI shells render the same way.

const { Op } = require("sequelize");
const { getModels } = require("../../../db/models");

function parseRange(query = {}) {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 7 * 86400000);
  const from = query.from ? new Date(query.from) : defaultFrom;
  const to = query.to ? new Date(query.to) : now;
  // Treat `to` as inclusive end-of-day if it's a bare date.
  if (query.to && /^\d{4}-\d{2}-\d{2}$/.test(query.to)) {
    to.setUTCHours(23, 59, 59, 999);
  }
  return { from, to };
}

async function getEmailAnalytics(query = {}) {
  const { TransactionalMessage, TransactionalDeliveryEvent, CrmMarketingMessage, CrmMarketingDeliveryEvent } = getModels();
  const { from, to } = parseRange(query);
  const locationId = query.locationId ? { locationId: Number(query.locationId) } : {};

  // Sent / Delivered / Failed live on the message row itself.
  const [transactionalMessages, marketingMessages] = await Promise.all([TransactionalMessage.findAll({
    where: {
      channel: "email",
      ...locationId,
      createdAt: { [Op.between]: [from, to] },
    },
    attributes: ["id", "status", "sentAt", "deliveredAt", "failedAt"],
  }), CrmMarketingMessage.findAll({
    where: {
      ...locationId,
      createdAt: { [Op.between]: [from, to] },
    },
    attributes: ["id", "status", "sentAt", "deliveredAt"],
  })]);

  let sent = 0;
  let delivered = 0;
  let failed = 0;
  const transactionalIds = [];
  const marketingIds = [];
  for (const m of transactionalMessages) {
    transactionalIds.push(m.id);
    if (m.sentAt) sent += 1;
    if (m.deliveredAt) delivered += 1;
    if (m.failedAt || m.status === "failed") failed += 1;
  }
  for (const m of marketingMessages) {
    marketingIds.push(m.id);
    if (m.sentAt) sent += 1;
    if (m.deliveredAt) delivered += 1;
    if (m.status === "failed") failed += 1;
  }

  // Engagement events come from the delivery_events stream.
  const COUNTED_TYPES = ["opened", "clicked", "bounced", "complained", "unsubscribed"];
  const [transactionalEvents, marketingEvents] = await Promise.all([
    transactionalIds.length ? TransactionalDeliveryEvent.findAll({
        where: {
          messageId: { [Op.in]: transactionalIds },
          eventType: { [Op.in]: COUNTED_TYPES },
        },
        attributes: ["messageId", "eventType", "payload", "occurredAt"],
      }) : [],
    marketingIds.length ? CrmMarketingDeliveryEvent.findAll({
      where: {
        messageId: { [Op.in]: marketingIds },
        eventType: { [Op.in]: ["open", "opened", "click", "clicked", "bounce", "bounced", "complaint", "complained", "unsubscribe", "unsubscribed"] },
      },
      attributes: ["messageId", "eventType", "payload", "occurredAt"],
    }) : [],
  ]);

  // Dedupe per (messageId, eventType) so a message that bounced 3 times
  // (provider retried) only counts once in "Bounced".
  const seen = new Set();
  const counts = { opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0 };
  for (const e of [...transactionalEvents, ...marketingEvents]) {
    const eventType = normalizeMetricEvent(e.eventType);
    if (!eventType) continue;
    const key = `${e.messageId}:${eventType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counts[eventType] = (counts[eventType] || 0) + 1;
  }

  // Percentages are relative to sent (industry convention).
  const pct = (n) => (sent > 0 ? Math.round((n / sent) * 1000) / 10 : 0);
  const reputation = reputationSummary({ sent, delivered, failed, counts });
  const engagement = engagementDetails([...transactionalEvents, ...marketingEvents]);
  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    volume: { transactional: transactionalMessages.length, marketing: marketingMessages.length },
    reputation,
    engagement,
    metrics: {
      sent: { count: sent, pct: sent > 0 ? 100 : 0 },
      delivered: { count: delivered, pct: pct(delivered) },
      opened: { count: counts.opened, pct: pct(counts.opened) },
      clicked: { count: counts.clicked, pct: pct(counts.clicked) },
      complained: { count: counts.complained, pct: pct(counts.complained) },
      bounced: { count: counts.bounced, pct: pct(counts.bounced) },
      unsubscribed: { count: counts.unsubscribed, pct: pct(counts.unsubscribed) },
      failed: { count: failed, pct: pct(failed) },
    },
  };
}

function engagementDetails(events = []) {
  const links = new Map();
  const devices = new Map();
  const clients = new Map();
  const locations = new Map();
  const seenEngagement = new Set();

  for (const event of events) {
    const type = normalizeMetricEvent(event.eventType);
    if (!['opened', 'clicked'].includes(type)) continue;
    const payload = event.payload || {};
    const uniqueKey = `${event.messageId}:${type}`;
    const firstForMessage = !seenEngagement.has(uniqueKey);
    seenEngagement.add(uniqueKey);
    const userAgent = payload.userAgent || payload.user_agent || payload.open?.userAgent || payload.click?.userAgent || "";
    if (firstForMessage) {
      incrementBucket(devices, classifyDevice(userAgent));
      incrementBucket(clients, classifyClient(userAgent));
      incrementBucket(locations, engagementLocation(payload));
    }

    if (type === 'clicked') {
      const url = payload.destinationUrl || payload.click?.link || payload.link || null;
      if (!url) continue;
      const key = String(url).slice(0, 2048);
      if (!links.has(key)) links.set(key, { url: key, totalClicks: 0, messageIds: new Set() });
      const link = links.get(key);
      link.totalClicks += 1;
      link.messageIds.add(String(event.messageId));
    }
  }

  return {
    openMeasurement: {
      quality: "estimated",
      explanation: "Open tracking can be inflated by privacy proxies such as Apple Mail Privacy Protection. Clicks and conversions are stronger engagement signals.",
    },
    links: Array.from(links.values())
      .map((item) => ({ url: item.url, uniqueClicks: item.messageIds.size, totalClicks: item.totalClicks }))
      .sort((a, b) => b.uniqueClicks - a.uniqueClicks || b.totalClicks - a.totalClicks)
      .slice(0, 50),
    devices: serializeBuckets(devices),
    clients: serializeBuckets(clients),
    locations: serializeBuckets(locations),
  };
}

function incrementBucket(map, label) {
  const key = label || "Unknown";
  map.set(key, Number(map.get(key) || 0) + 1);
}

function serializeBuckets(map) {
  return Array.from(map.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function classifyDevice(userAgent = "") {
  const ua = String(userAgent);
  if (!ua) return "Unknown";
  if (/ipad|tablet/i.test(ua)) return "Tablet";
  if (/mobile|iphone|android/i.test(ua)) return "Mobile";
  return "Desktop";
}

function classifyClient(userAgent = "") {
  const ua = String(userAgent);
  if (!ua) return "Unknown";
  if (/GoogleImageProxy/i.test(ua)) return "Gmail image proxy";
  if (/Outlook|Microsoft Office/i.test(ua)) return "Microsoft Outlook";
  if (/Thunderbird/i.test(ua)) return "Thunderbird";
  if (/iPhone|iPad|Macintosh|AppleWebKit/i.test(ua) && !/Chrome|CriOS|Edg/i.test(ua)) return "Apple Mail / Safari";
  if (/Chrome|CriOS/i.test(ua)) return "Chrome";
  if (/Firefox/i.test(ua)) return "Firefox";
  return "Other";
}

function engagementLocation(payload = {}) {
  return payload.country
    || payload.countryCode
    || payload.geo?.country
    || payload.open?.ipAddressCountry
    || payload.click?.ipAddressCountry
    || "Unknown";
}

function normalizeMetricEvent(value) {
  const key = String(value || "").toLowerCase();
  return ({ open: "opened", opened: "opened", click: "clicked", clicked: "clicked", bounce: "bounced", bounced: "bounced", complaint: "complained", complained: "complained", unsubscribe: "unsubscribed", unsubscribed: "unsubscribed" })[key] || null;
}

function reputationSummary({ sent, delivered, failed, counts }) {
  const rate = (value) => sent ? Math.round((Number(value || 0) / sent) * 10000) / 100 : 0;
  const deliveryRate = rate(delivered);
  const bounceRate = rate(counts.bounced);
  const complaintRate = rate(counts.complained);
  const unsubscribeRate = rate(counts.unsubscribed);
  const failureRate = rate(failed);
  const score = sent ? Math.max(0, Math.round(100
    - Math.min(45, bounceRate * 6)
    - Math.min(35, complaintRate * 100)
    - Math.min(10, unsubscribeRate * 2)
    - Math.min(10, failureRate))) : null;
  const status = score === null ? "no_data" : score >= 90 ? "excellent" : score >= 75 ? "good" : score >= 55 ? "attention" : "critical";
  const recommendations = [];
  if (!sent) recommendations.push("Send only to opted-in contacts; reputation guidance appears after delivery events arrive.");
  if (bounceRate >= 2) recommendations.push("Pause risky audiences and clean invalid addresses before the next campaign.");
  if (complaintRate >= 0.1) recommendations.push("Complaint rate is high. Narrow targeting, confirm consent, and reduce frequency.");
  if (unsubscribeRate >= 1) recommendations.push("Review content relevance and make preference choices clearer.");
  if (failureRate >= 2) recommendations.push("Check provider, DNS, quota, and failed-message reasons before sending again.");
  if (sent && !recommendations.length) recommendations.push("Current signals are healthy. Keep sending consistently to engaged recipients.");
  return { score, status, deliveryRate, bounceRate, complaintRate, unsubscribeRate, failureRate, recommendations };
}

// Heuristic ESP detection from recipient domain — production should also
// inspect the bounce report's reporting MTA (event payload).
function detectEspFromAddress(address) {
  const domain = String(address || "").split("@")[1]?.toLowerCase() || "";
  if (/(gmail|googlemail)\./.test(domain)) return "Gmail";
  if (/(outlook|hotmail|live|msn)\./.test(domain)) return "Outlook US";
  if (/(office365|onmicrosoft|outlook365)\./.test(domain)) return "Outlook 365";
  if (/yahoo\./.test(domain)) return "Yahoo";
  if (/(apple|icloud|me\.com|mac\.com)\./.test(domain)) return "Apple";
  if (/(bell|rogers|telus|shaw)\.ca$/.test(domain)) return "Canadian";
  return "Other";
}

// Map provider error code / SMTP status to a bounce category + human
// definition. The lookup is intentionally simple; the messaging-core can
// override per-event with richer metadata in the payload.
const STATUS_DEFINITIONS = [
  { match: /^4\.2\.2|452/, category: "Mailbox Full/Unavailable", definition: "The recipient's mailbox is full and cannot accept new messages until space is freed." },
  { match: /^5\.5\.0|550/,  category: "Mailbox Full/Unavailable", definition: "The recipient's mailbox is unavailable or cannot accept messages." },
  { match: /^5\.1\.[1-7]|550/, category: "Uncategorized", definition: "Possible reasons: invalid email address, failed DMARC/DKIM authentication, or IP address on a DNS blacklist." },
  { match: /^5\.7\.1|554|501/, category: "Spam-Like / Unsolicited", definition: "The message was rejected as spam or for violating recipient security or content policies." },
  { match: /^4\.1\.8|450/, category: "No MX / DNS Issue", definition: "The sender's domain could not be found in DNS, so the message was rejected." },
  { match: /^602/, category: "Rate Limited/Throttled", definition: "The sending server is temporarily restricted due to high volume or low reputation." },
];

function classifyStatus(errorCode, statusCode) {
  const haystack = `${statusCode || ""} ${errorCode || ""}`.trim();
  for (const def of STATUS_DEFINITIONS) {
    if (def.match.test(haystack)) return def;
  }
  return { category: "Uncategorized", definition: "Bounce reason not yet classified." };
}

async function getBounceClassification(query = {}) {
  const { TransactionalMessage, TransactionalDeliveryEvent } = getModels();
  const { from, to } = parseRange(query);
  const locationId = query.locationId ? { locationId: Number(query.locationId) } : {};

  // Pull email-channel messages for the window once so we have address +
  // delivered counts without re-running the join per row.
  const messages = await TransactionalMessage.findAll({
    where: {
      channel: "email",
      ...locationId,
      createdAt: { [Op.between]: [from, to] },
    },
    attributes: ["id", "recipientAddress", "deliveredAt", "status"],
  });
  const messagesById = new Map(messages.map((m) => [m.id, m]));
  const totalDelivered = messages.filter((m) => m.deliveredAt).length;

  const bounceEvents = messages.length
    ? await TransactionalDeliveryEvent.findAll({
        where: {
          messageId: { [Op.in]: messages.map((m) => m.id) },
          eventType: "bounced",
        },
      })
    : [];

  // Group by (esp, errorCode, statusCode).
  const buckets = new Map();
  let permanentBounces = 0;
  let espBlocks = 0;
  for (const e of bounceEvents) {
    const payload = e.payload || {};
    const errorCode = String(payload.errorCode || payload.error_code || "");
    const statusCode = String(payload.statusCode || payload.status_code || "");
    const isPermanent = payload.bounceType
      ? String(payload.bounceType).toLowerCase() === "permanent"
      : /^5/.test(statusCode);
    if (isPermanent) permanentBounces += 1;
    if (/(blocked|throttled|rate limit)/i.test(payload.reason || "") || /^602/.test(errorCode)) {
      espBlocks += 1;
    }
    const msg = messagesById.get(e.messageId);
    const esp = detectEspFromAddress(msg?.recipientAddress);
    const { category, definition } = classifyStatus(errorCode, statusCode);
    const key = `${esp}:${category}:${errorCode}:${statusCode}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        emailServiceProvider: esp,
        category,
        errorCode: errorCode || "—",
        statusCode: statusCode || "NA",
        definition,
        count: 0,
      });
    }
    buckets.get(key).count += 1;
  }

  const total = bounceEvents.length || 0;
  const overview = Array.from(buckets.values())
    .map((b) => ({
      ...b,
      pct: total > 0 ? Math.round((b.count / total) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.count - a.count);

  const totalAttempts = messages.length;
  const permanentBounceRate = totalAttempts > 0
    ? Math.round((permanentBounces / totalAttempts) * 10000) / 100
    : 0;
  const deliveryRate = totalAttempts > 0
    ? Math.round((totalDelivered / totalAttempts) * 10000) / 100
    : 0;

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    summary: {
      permanentBounces,
      permanentBounceRate,
      espBlocks,
      delivered: totalDelivered,
      deliveryRate,
    },
    overview,
  };
}

module.exports = {
  getEmailAnalytics,
  getBounceClassification,
  reputationSummary,
  engagementDetails,
  classifyDevice,
  classifyClient,
};
