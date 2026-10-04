const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const { Op } = require("sequelize");
const { getModels } = require("../../../db/models");
const emailService = require("./service");

function error(message, statusCode = 400) { const value = new Error(message); value.statusCode = statusCode; return value; }
function plain(row) { return row?.get ? row.get({ plain: true }) : row; }
function clamp(value, min, max, fallback) { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback; }
function requireLocation(value) { const id = Number(value); if (!Number.isInteger(id) || id < 1) throw error("locationId is required."); return id; }

function serialize(row) {
  const value = plain(row);
  return { ...value, lockedAt: undefined, lockedBy: undefined };
}

function safeFeedUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch { throw error("A valid feed URL is required."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw error("Feed URL must be a public HTTP or HTTPS URL.");
  return url;
}

function privateIp(address) {
  if (net.isIPv4(address)) {
    const parts = address.split(".").map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
  }
  const ip = String(address).toLowerCase();
  return ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:") || ip === "::";
}

async function assertPublicHost(url) {
  const records = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!records.length || records.some((item) => privateIp(item.address))) throw error("Feed URL must resolve only to public internet addresses.");
}

async function fetchFeed(urlValue, fetchImpl = fetch) {
  let url = safeFeedUrl(urlValue);
  for (let redirect = 0; redirect < 4; redirect += 1) {
    await assertPublicHost(url);
    const response = await fetchImpl(url, { redirect: "manual", headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" }, signal: AbortSignal.timeout(10000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get("location");
      if (!next) throw error("RSS redirect did not include a location.", 502);
      url = safeFeedUrl(new URL(next, url).toString());
      continue;
    }
    if (!response.ok) throw error(`RSS feed returned HTTP ${response.status}.`, 502);
    const text = await response.text();
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw error("RSS feed exceeds the 2 MB limit.", 422);
    return { url: url.toString(), text };
  }
  throw error("RSS feed redirected too many times.", 502);
}

function decodeXml(value) {
  return String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").trim();
}
function tag(block, names) {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
    if (match) return decodeXml(match[1]);
  }
  return "";
}
function stripHtml(value) { return String(value || "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }

function parseFeed(xml) {
  const blocks = String(xml || "").match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) || [];
  const items = blocks.slice(0, 50).map((block) => {
    const atomLink = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i)?.[1] || "";
    const descriptionHtml = tag(block, ["content:encoded", "content", "description", "summary"]);
    const item = {
      title: stripHtml(tag(block, ["title"])), link: decodeXml(tag(block, ["link"]) || atomLink),
      guid: stripHtml(tag(block, ["guid", "id"])), publishedAt: stripHtml(tag(block, ["pubDate", "published", "updated"])),
      description: stripHtml(descriptionHtml), descriptionHtml,
    };
    item.fingerprint = crypto.createHash("sha256").update(item.guid || item.link || `${item.title}|${item.publishedAt}`).digest("hex");
    return item;
  }).filter((item) => item.title || item.link || item.guid);
  if (!items.length) throw error("No RSS or Atom items were found in this feed.", 422);
  return { title: stripHtml(tag(xml, ["title"])), items };
}

function payload(input, existing = {}) {
  const next = {
    name: input.name === undefined ? existing.name : String(input.name || "").trim().slice(0, 200),
    feedUrl: input.feedUrl === undefined ? existing.feedUrl : safeFeedUrl(input.feedUrl).toString(),
    templateId: input.templateId === undefined ? existing.templateId : input.templateId,
    subjectTemplate: input.subjectTemplate === undefined ? (existing.subjectTemplate || "{{rss.title}}") : String(input.subjectTemplate || "{{rss.title}}").slice(0, 500),
    audience: input.audience === undefined ? (existing.audience || {}) : (input.audience && typeof input.audience === "object" ? input.audience : {}),
    sendOptions: input.sendOptions === undefined ? (existing.sendOptions || {}) : (input.sendOptions && typeof input.sendOptions === "object" ? input.sendOptions : {}),
    intervalMinutes: input.intervalMinutes === undefined ? (existing.intervalMinutes || 60) : clamp(input.intervalMinutes, 15, 10080, 60),
    status: input.status === undefined ? (existing.status || "active") : (input.status === "paused" ? "paused" : "active"),
    sendLatestOnFirstPoll: input.sendLatestOnFirstPoll === undefined ? Boolean(existing.sendLatestOnFirstPoll) : input.sendLatestOnFirstPoll === true,
  };
  if (!next.name || !next.feedUrl || !next.templateId) throw error("Name, feed URL, and marketing template are required.");
  if (!next.audience.segmentId && !next.audience.filters && !next.audience.search && !next.audience.allowAll && !next.audience.ids?.length) throw error("Choose an RSS campaign audience.");
  return next;
}

async function list(input = {}) {
  const locationId = requireLocation(input.locationId);
  const { CrmRssCampaign } = getModels();
  return (await CrmRssCampaign.findAll({ where: { locationId }, order: [["createdAt", "DESC"]] })).map(serialize);
}

async function create(input = {}) {
  const locationId = requireLocation(input.locationId); const models = getModels(); const values = payload(input);
  const template = await models.CrmMarketingTemplate.findOne({ where: { id: values.templateId, locationId } });
  if (!template || template.useCase === "transactional") throw error("Choose a marketing template from this location.");
  return serialize(await models.CrmRssCampaign.create({ locationId, ...values, nextPollAt: new Date() }));
}

async function update(id, input = {}) {
  const locationId = requireLocation(input.locationId); const models = getModels();
  const row = await models.CrmRssCampaign.findOne({ where: { id, locationId } }); if (!row) throw error("RSS campaign not found.", 404);
  const values = payload(input, plain(row)); await row.update({ ...values, nextPollAt: values.status === "active" ? new Date() : row.nextPollAt }); return serialize(row);
}

async function remove(id, input = {}) {
  const locationId = requireLocation(input.locationId); const { CrmRssCampaign } = getModels();
  const row = await CrmRssCampaign.findOne({ where: { id, locationId } }); if (!row) throw error("RSS campaign not found.", 404);
  await row.destroy(); return { id };
}

function interpolate(value, data) { return String(value || "").replace(/\{\{\s*rss\.([a-zA-Z0-9_]+)\s*\}\}/g, (_all, key) => data[key] == null ? "" : String(data[key])); }

async function pollRow(row, { force = false, fetchImpl = fetch } = {}) {
  if (row.status !== "active" && !force) return { skipped: true, reason: "paused", id: row.id };
  const { text } = await fetchFeed(row.feedUrl, fetchImpl); const feed = parseFeed(text); const item = feed.items[0]; const first = !row.lastItemFingerprint;
  const nextPollAt = new Date(Date.now() + clamp(row.intervalMinutes, 15, 10080, 60) * 60000);
  const resumePending = item.fingerprint === row.lastItemFingerprint && row.lastItem?.pending === true && row.lastCampaignId;
  if ((!resumePending && item.fingerprint === row.lastItemFingerprint) || (first && !row.sendLatestOnFirstPoll && !force)) {
    await row.update({ lastItemFingerprint: item.fingerprint, lastItem: item, lastPolledAt: new Date(), nextPollAt, lastError: null, lockedAt: null, lockedBy: null });
    return { skipped: true, reason: first ? "baseline_created" : "no_new_item", item, id: row.id };
  }
  const campaign = resumePending
    ? { id: row.lastCampaignId }
    : await emailService.createCampaign({ locationId: row.locationId, name: `${row.name} — ${item.title}`.slice(0, 200), campaignType: "rss_campaign", templateId: row.templateId });
  if (!resumePending) await row.update({ lastItemFingerprint: item.fingerprint, lastItem: { ...item, pending: true }, lastCampaignId: campaign.id });
  const rss = { ...item, feedTitle: feed.title, feedUrl: row.feedUrl };
  const queued = await emailService.queueCampaignMessages(campaign.id, {
    ...(row.audience || {}), ...(row.sendOptions || {}), templateId: row.templateId,
    subject: interpolate(row.subjectTemplate, rss), data: { rss }, source: "rss_campaign",
  });
  await row.update({ lastItemFingerprint: item.fingerprint, lastItem: { ...item, pending: false }, lastPolledAt: new Date(), lastPublishedAt: new Date(), lastCampaignId: campaign.id, nextPollAt, lastError: null, lockedAt: null, lockedBy: null });
  return { skipped: false, item, campaignId: campaign.id, queued, id: row.id };
}

async function poll(id, input = {}, options = {}) {
  const locationId = requireLocation(input.locationId); const { CrmRssCampaign } = getModels();
  const row = await CrmRssCampaign.findOne({ where: { id, locationId } }); if (!row) throw error("RSS campaign not found.", 404);
  try { return await pollRow(row, { force: input.force === true, ...options }); } catch (err) { await row.update({ lastPolledAt: new Date(), nextPollAt: new Date(Date.now() + row.intervalMinutes * 60000), lastError: String(err.message || err).slice(0, 2000), lockedAt: null, lockedBy: null }); throw err; }
}

async function claimDue({ workerId, limit = 10 }) {
  const { CrmRssCampaign } = getModels();
  await CrmRssCampaign.update({ lockedAt: null, lockedBy: null }, { where: { lockedAt: { [Op.lt]: new Date(Date.now() - 10 * 60000) } } });
  const rows = await CrmRssCampaign.findAll({ where: { status: "active", nextPollAt: { [Op.lte]: new Date() }, lockedAt: null }, order: [["nextPollAt", "ASC"]], limit });
  const claimed = [];
  for (const row of rows) { const [count] = await CrmRssCampaign.update({ lockedAt: new Date(), lockedBy: workerId }, { where: { id: row.id, lockedAt: null } }); if (count) claimed.push(await CrmRssCampaign.findByPk(row.id)); }
  return claimed;
}

module.exports = { list, create, update, remove, poll, pollRow, claimDue, _internal: { safeFeedUrl, privateIp, parseFeed, interpolate } };
