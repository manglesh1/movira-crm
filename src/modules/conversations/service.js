const { Op } = require("sequelize");
const { getModels } = require("../../db/models");
const config = require("../../config");
const webchatService = require("./webchatService");

const STATUSES = new Set(["open", "pending", "snoozed", "resolved", "spam"]);
const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const CHANNEL_CATALOG = [
  { channel: "facebook", label: "Facebook Messenger", availability: "available", provider: "meta" },
  { channel: "instagram", label: "Instagram Direct", availability: "available", provider: "meta" },
  { channel: "whatsapp", label: "WhatsApp", availability: "planned", provider: "meta" },
  { channel: "webchat", label: "Website Chat", availability: "available", provider: "movira" },
  { channel: "sms", label: "SMS", availability: "planned", provider: null },
  { channel: "email", label: "Email replies", availability: "available", provider: "movira", connectable: false },
  { channel: "telegram", label: "Telegram", availability: "planned", provider: "telegram" },
  { channel: "x", label: "X Direct Messages", availability: "planned", provider: "x" },
  { channel: "linkedin", label: "LinkedIn", availability: "restricted", provider: "linkedin" },
];

function serviceError(message, statusCode = 400, code = "invalid_request") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function locationId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw serviceError("locationId is required.", 400, "location_id_required");
  return id;
}

function positiveInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function encodeCursor(row) {
  if (!row) return null;
  return Buffer.from(JSON.stringify({ at: new Date(row.lastMessageAt || row.createdAt).toISOString(), id: row.id })).toString("base64url");
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (!parsed.id || !parsed.at || Number.isNaN(Date.parse(parsed.at))) throw new Error("bad cursor");
    return { id: String(parsed.id), at: new Date(parsed.at) };
  } catch {
    throw serviceError("cursor is invalid.", 400, "invalid_cursor");
  }
}

function conversationCapabilities(conversation, connection, now = new Date()) {
  const connected = connection?.status === "connected";
  const closesAt = conversation?.replyWindowClosesAt ? new Date(conversation.replyWindowClosesAt) : null;
  const replyWindowOpen = !closesAt || closesAt.getTime() > now.getTime();
  const providerCanReply = connection?.capabilities?.sendMessages === true;
  let replyBlockedReason = null;
  if (!connected) replyBlockedReason = "channel_not_connected";
  else if (!providerCanReply) replyBlockedReason = "provider_send_not_supported";
  else if (!replyWindowOpen) replyBlockedReason = "reply_window_closed";
  return {
    canReply: connected && providerCanReply && replyWindowOpen,
    replyBlockedReason,
    replyWindowClosesAt: closesAt?.toISOString() || null,
    canAddInternalNote: true,
    canAssign: true,
  };
}

function safeConnection(connection) {
  if (!connection) return null;
  const value = connection.toJSON ? connection.toJSON() : { ...connection };
  delete value.encryptedCredentials;
  return value;
}

async function listChannels(input) {
  const id = locationId(input.locationId);
  const { CrmConversationChannelConnection } = getModels();
  const rows = await CrmConversationChannelConnection.findAll({
    where: { locationId: id },
    order: [["createdAt", "DESC"]],
  });
  const meta = config.integrations.meta;
  const credentialsEncryptionReady = Boolean(config.credentialsEncryptionKey) || config.env !== "production";
  const metaPlatformReady = Boolean(
    meta.appId
    && meta.appSecret
    && meta.oauthRedirectUri
    && config.webhooks.metaVerifyToken
    && credentialsEncryptionReady
  );
  return CHANNEL_CATALOG.map((item) => {
    const platformReady = item.provider !== "meta" || metaPlatformReady;
    return {
      ...item,
      platformReady,
      connectable: item.connectable !== false && item.availability === "available" && platformReady,
      connections: rows.filter((row) => row.channel === item.channel).map((row) => {
        const safe = safeConnection(row);
        if (item.channel === "webchat") safe.settings = webchatService.settingsFor(row);
        return safe;
      }),
    };
  });
}

const conversationIncludes = (models) => [
  { model: models.CrmConversationChannelConnection, as: "connection", attributes: { exclude: ["encryptedCredentials"] } },
  { model: models.CrmConversationIdentity, as: "identity", required: false },
  { model: models.CrmContact, as: "contact", required: false, attributes: ["id", "fullName", "firstName", "lastName", "email", "phone", "lifecycle", "tags"] },
  { model: models.CrmConversationTag, as: "tags", required: false },
];

async function listConversations(input) {
  const id = locationId(input.locationId);
  const limit = positiveInt(input.limit, 30, 100);
  const cursor = decodeCursor(input.cursor);
  const models = getModels();
  const where = { locationId: id };
  if (input.status) {
    if (!STATUSES.has(input.status)) throw serviceError("status is invalid.");
    where.status = input.status;
  }
  if (input.channel) where.channel = String(input.channel).toLowerCase();
  if (input.assignedUserId === "unassigned") where.assignedUserId = null;
  else if (input.assignedUserId) where.assignedUserId = positiveInt(input.assignedUserId, 0, Number.MAX_SAFE_INTEGER);
  if (input.priority) {
    if (!PRIORITIES.has(input.priority)) throw serviceError("priority is invalid.");
    where.priority = input.priority;
  }
  if (cursor) {
    where[Op.or] = [
      { lastMessageAt: { [Op.lt]: cursor.at } },
      { lastMessageAt: cursor.at, id: { [Op.lt]: cursor.id } },
    ];
  }
  const rows = await models.CrmConversation.findAll({
    where,
    include: conversationIncludes(models),
    order: [["lastMessageAt", "DESC NULLS LAST"], ["id", "DESC"]],
    limit: limit + 1,
    distinct: true,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const messageIds = page.map((row) => row.lastMessageId).filter(Boolean);
  const lastMessages = messageIds.length
    ? await models.CrmConversationMessage.findAll({
      where: { locationId: id, id: { [Op.in]: messageIds } },
      attributes: ["id", "direction", "messageType", "textBody", "status", "occurredAt"],
    })
    : [];
  const lastMessageById = new Map(lastMessages.map((message) => [message.id, message.toJSON()]));
  return {
    items: page.map((row) => {
      const value = row.toJSON();
      value.lastMessage = lastMessageById.get(value.lastMessageId) || null;
      value.capabilities = conversationCapabilities(value, value.connection);
      return value;
    }),
    pageInfo: { hasMore, nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null },
  };
}

async function findConversation(id, scopedLocationId, options = {}) {
  const models = getModels();
  const row = await models.CrmConversation.findOne({
    where: { id, locationId: locationId(scopedLocationId) },
    include: options.include === false ? [] : conversationIncludes(models),
    transaction: options.transaction,
    lock: options.lock,
  });
  if (!row) throw serviceError("Conversation not found.", 404, "conversation_not_found");
  return row;
}

async function getConversation(id, input) {
  const row = await findConversation(id, input.locationId);
  const value = row.toJSON();
  value.capabilities = conversationCapabilities(value, value.connection);
  return value;
}

async function listMessages(conversationId, input) {
  const id = locationId(input.locationId);
  await findConversation(conversationId, id, { include: false });
  const limit = positiveInt(input.limit, 50, 100);
  const before = input.before ? new Date(input.before) : null;
  if (before && Number.isNaN(before.getTime())) throw serviceError("before is invalid.");
  const { CrmConversationMessage } = getModels();
  const where = { locationId: id, conversationId };
  if (before) where.occurredAt = { [Op.lt]: before };
  const rows = await CrmConversationMessage.findAll({ where, order: [["occurredAt", "DESC"], ["id", "DESC"]], limit: limit + 1 });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return { items: page.reverse(), pageInfo: { hasMore, nextBefore: hasMore ? page[page.length - 1].occurredAt : null } };
}

async function addInternalNote(conversationId, input, actorUserId) {
  const id = locationId(input.locationId);
  const textBody = String(input.textBody || "").trim();
  if (!textBody) throw serviceError("Note text is required.");
  if (textBody.length > 10000) throw serviceError("Note text is too long.");
  const models = getModels();
  return models.sequelize.transaction(async (transaction) => {
    const conversation = await findConversation(conversationId, id, { include: false, transaction, lock: transaction.LOCK.UPDATE });
    const message = await models.CrmConversationMessage.create({
      locationId: id, conversationId, connectionId: conversation.connectionId, direction: "internal",
      messageType: "note", textBody, status: "recorded", sentByUserId: actorUserId || null,
      occurredAt: new Date(), metadataSafe: { mentions: Array.isArray(input.mentions) ? input.mentions.slice(0, 50) : [] },
    }, { transaction });
    await models.CrmConversationOutbox.create({
      locationId: id, aggregateType: "conversation", aggregateId: conversationId,
      eventType: "conversation.internal_note.created", payloadSafe: { conversationId, messageId: message.id },
    }, { transaction });
    return message;
  });
}

async function updateAssignment(conversationId, input, actorUserId) {
  const id = locationId(input.locationId);
  const models = getModels();
  return models.sequelize.transaction(async (transaction) => {
    const row = await findConversation(conversationId, id, { include: false, transaction, lock: transaction.LOCK.UPDATE });
    const previous = { teamId: row.assignedTeamId, userId: row.assignedUserId };
    const toUserId = input.assignedUserId === null ? null : (input.assignedUserId ? positiveInt(input.assignedUserId, 0, Number.MAX_SAFE_INTEGER) : row.assignedUserId);
    const toTeamId = input.assignedTeamId === null ? null : (input.assignedTeamId === undefined ? row.assignedTeamId : String(input.assignedTeamId).trim() || null);
    await row.update({ assignedUserId: toUserId || null, assignedTeamId: toTeamId }, { transaction });
    await models.CrmConversationAssignment.create({
      locationId: id, conversationId, fromTeamId: previous.teamId, fromUserId: previous.userId,
      toTeamId, toUserId: toUserId || null, assignedByUserId: actorUserId || null,
      reason: input.reason ? String(input.reason).slice(0, 500) : null,
    }, { transaction });
    await models.CrmConversationOutbox.create({
      locationId: id, aggregateType: "conversation", aggregateId: conversationId,
      eventType: "conversation.assignment.changed",
      payloadSafe: { conversationId, assignedTeamId: toTeamId, assignedUserId: toUserId || null },
    }, { transaction });
    return row;
  });
}

async function updateStatus(conversationId, input) {
  const id = locationId(input.locationId);
  const status = String(input.status || "").toLowerCase();
  if (!STATUSES.has(status)) throw serviceError("status is invalid.");
  const snoozedUntil = status === "snoozed" ? new Date(input.snoozedUntil) : null;
  if (status === "snoozed" && (!input.snoozedUntil || Number.isNaN(snoozedUntil.getTime()) || snoozedUntil <= new Date())) {
    throw serviceError("A future snoozedUntil value is required.");
  }
  const models = getModels();
  return models.sequelize.transaction(async (transaction) => {
    const row = await findConversation(conversationId, id, { include: false, transaction, lock: transaction.LOCK.UPDATE });
    await row.update({ status, snoozedUntil, closedAt: ["resolved", "spam"].includes(status) ? new Date() : null }, { transaction });
    await models.CrmConversationOutbox.create({
      locationId: id, aggregateType: "conversation", aggregateId: conversationId,
      eventType: "conversation.status.changed", payloadSafe: { conversationId, status, snoozedUntil },
    }, { transaction });
    return row;
  });
}

async function markRead(conversationId, input) {
  const id = locationId(input.locationId);
  const models = getModels();
  return models.sequelize.transaction(async (transaction) => {
    const row = await findConversation(conversationId, id, { include: false, transaction, lock: transaction.LOCK.UPDATE });
    if (row.unreadCount !== 0) {
      await row.update({ unreadCount: 0 }, { transaction });
      await models.CrmConversationOutbox.create({
        locationId: id, aggregateType: "conversation", aggregateId: conversationId,
        eventType: "conversation.read", payloadSafe: { conversationId },
      }, { transaction });
    }
    return { id: row.id, unreadCount: row.unreadCount };
  });
}

const ROUTING_DEFAULTS = Object.freeze({
  roundRobin: false, skipUnavailable: true, fallbackInbox: "Customer care", slaEnabled: false,
  firstResponseMinutes: 15, nextResponseMinutes: 60, escalationInbox: "Manager",
});
const PREFERENCE_DEFAULTS = Object.freeze({
  enterSend: true, sound: true, browser: false, aiSummary: false, aiReply: false,
  csat: false, autoClose: false, transcript: true, defaultView: "mine", reopenWindowDays: "30", retentionMonths: "24",
});

function requiredText(value, field, max) {
  const text = String(value || "").trim();
  if (!text) throw serviceError(`${field} is required.`);
  if (text.length > max) throw serviceError(`${field} is too long.`);
  return text;
}

function cleanRouting(input = {}) {
  const positiveChoice = (value, fallback, choices) => choices.includes(Number(value)) ? Number(value) : fallback;
  return {
    roundRobin: input.roundRobin === true, skipUnavailable: input.skipUnavailable !== false,
    fallbackInbox: requiredText(input.fallbackInbox || ROUTING_DEFAULTS.fallbackInbox, "fallbackInbox", 120),
    slaEnabled: input.slaEnabled === true,
    firstResponseMinutes: positiveChoice(input.firstResponseMinutes, 15, [5, 15, 30]),
    nextResponseMinutes: positiveChoice(input.nextResponseMinutes, 60, [30, 60, 240]),
    escalationInbox: requiredText(input.escalationInbox || ROUTING_DEFAULTS.escalationInbox, "escalationInbox", 120),
  };
}

function cleanPreferences(input = {}) {
  return {
    enterSend: input.enterSend !== false, sound: input.sound !== false, browser: input.browser === true,
    aiSummary: input.aiSummary === true, aiReply: input.aiReply === true, csat: input.csat === true,
    autoClose: input.autoClose === true, transcript: input.transcript !== false,
    defaultView: ["mine", "all", "unassigned"].includes(input.defaultView) ? input.defaultView : "mine",
    reopenWindowDays: ["7", "30", "always"].includes(String(input.reopenWindowDays)) ? String(input.reopenWindowDays) : "30",
    retentionMonths: ["6", "12", "24", "custom"].includes(String(input.retentionMonths)) ? String(input.retentionMonths) : "24",
  };
}

async function getWorkspace(input) {
  const id = locationId(input.locationId);
  const { CrmConversationWorkspaceConfig } = getModels();
  const row = await CrmConversationWorkspaceConfig.findOne({ where: { locationId: id } });
  return {
    routing: { ...ROUTING_DEFAULTS, ...(row?.routing || {}) },
    preferences: { ...PREFERENCE_DEFAULTS, ...(row?.preferences || {}) },
  };
}

async function updateWorkspace(input, actorUserId) {
  const id = locationId(input.locationId);
  const models = getModels();
  const current = await models.CrmConversationWorkspaceConfig.findOne({ where: { locationId: id } });
  const values = {
    routing: input.routing ? cleanRouting(input.routing) : { ...ROUTING_DEFAULTS, ...(current?.routing || {}) },
    preferences: input.preferences ? cleanPreferences(input.preferences) : { ...PREFERENCE_DEFAULTS, ...(current?.preferences || {}) },
    updatedByUserId: actorUserId || null,
  };
  const [row] = await models.CrmConversationWorkspaceConfig.upsert({ locationId: id, ...values }, { returning: true });
  return { routing: row.routing, preferences: row.preferences };
}

async function listRoutingRules(input) {
  const { CrmConversationRoutingRule } = getModels();
  const rows = await CrmConversationRoutingRule.findAll({ where: { locationId: locationId(input.locationId) }, order: [["sortOrder", "ASC"], ["createdAt", "ASC"]] });
  return rows.map((row) => ({ ...row.toJSON(), priority: row.priority.replace(/^./, (value) => value.toUpperCase()) }));
}

function routingRuleValues(input, actorUserId) {
  const priority = String(input.priority || "normal").toLowerCase();
  if (!PRIORITIES.has(priority)) throw serviceError("priority is invalid.");
  return {
    condition: requiredText(input.condition, "condition", 500), destination: requiredText(input.destination, "destination", 120),
    priority, active: input.active !== false, sortOrder: Number.isInteger(Number(input.sortOrder)) ? Number(input.sortOrder) : 0,
    ...(actorUserId ? { createdByUserId: actorUserId } : {}),
  };
}

async function createRoutingRule(input, actorUserId) {
  const id = locationId(input.locationId);
  return getModels().CrmConversationRoutingRule.create({ locationId: id, ...routingRuleValues(input, actorUserId) });
}

async function updateRoutingRule(ruleId, input) {
  const id = locationId(input.locationId);
  const row = await getModels().CrmConversationRoutingRule.findOne({ where: { id: ruleId, locationId: id } });
  if (!row) throw serviceError("Routing rule not found.", 404, "routing_rule_not_found");
  return row.update(routingRuleValues({ ...row.toJSON(), ...input }));
}

async function deleteRoutingRule(ruleId, input) {
  const deleted = await getModels().CrmConversationRoutingRule.destroy({ where: { id: ruleId, locationId: locationId(input.locationId) } });
  if (!deleted) throw serviceError("Routing rule not found.", 404, "routing_rule_not_found");
  return { id: ruleId, deleted: true };
}

async function listSavedReplies(input) {
  return getModels().CrmConversationSavedReply.findAll({ where: { locationId: locationId(input.locationId) }, order: [["updatedAt", "DESC"]] });
}

function savedReplyValues(input, actorUserId) {
  const shortcut = requiredText(input.shortcut, "shortcut", 80);
  if (!shortcut.startsWith("/")) throw serviceError("shortcut must start with /.");
  return {
    title: requiredText(input.title, "title", 180), shortcut, category: requiredText(input.category || "General", "category", 80),
    body: requiredText(input.body, "body", 10000), ...(actorUserId ? { createdByUserId: actorUserId } : {}),
  };
}

async function createSavedReply(input, actorUserId) {
  return getModels().CrmConversationSavedReply.create({ locationId: locationId(input.locationId), ...savedReplyValues(input, actorUserId) });
}

async function updateSavedReply(replyId, input) {
  const id = locationId(input.locationId);
  const row = await getModels().CrmConversationSavedReply.findOne({ where: { id: replyId, locationId: id } });
  if (!row) throw serviceError("Saved reply not found.", 404, "saved_reply_not_found");
  return row.update(savedReplyValues({ ...row.toJSON(), ...input }));
}

async function deleteSavedReply(replyId, input) {
  const deleted = await getModels().CrmConversationSavedReply.destroy({ where: { id: replyId, locationId: locationId(input.locationId) } });
  if (!deleted) throw serviceError("Saved reply not found.", 404, "saved_reply_not_found");
  return { id: replyId, deleted: true };
}

async function listAutomationRules(input) {
  return getModels().CrmConversationAutomationRule.findAll({ where: { locationId: locationId(input.locationId) }, order: [["updatedAt", "DESC"]] });
}

function automationRuleValues(input, actorUserId) {
  return {
    name: requiredText(input.name, "name", 180), trigger: requiredText(input.trigger, "trigger", 255),
    action: requiredText(input.action, "action", 255), active: input.active === true,
    ...(actorUserId ? { createdByUserId: actorUserId } : {}),
  };
}

async function createAutomationRule(input, actorUserId) {
  return getModels().CrmConversationAutomationRule.create({ locationId: locationId(input.locationId), ...automationRuleValues(input, actorUserId) });
}

async function updateAutomationRule(ruleId, input) {
  const id = locationId(input.locationId);
  const row = await getModels().CrmConversationAutomationRule.findOne({ where: { id: ruleId, locationId: id } });
  if (!row) throw serviceError("Automation rule not found.", 404, "automation_rule_not_found");
  return row.update(automationRuleValues({ ...row.toJSON(), ...input }));
}

async function deleteAutomationRule(ruleId, input) {
  const deleted = await getModels().CrmConversationAutomationRule.destroy({ where: { id: ruleId, locationId: locationId(input.locationId) } });
  if (!deleted) throw serviceError("Automation rule not found.", 404, "automation_rule_not_found");
  return { id: ruleId, deleted: true };
}

function durationLabel(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  const minutes = Math.round(milliseconds / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

async function getAnalytics(input) {
  const id = locationId(input.locationId);
  const days = [7, 30, 90].includes(Number(input.days)) ? Number(input.days) : 30;
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const previousStart = new Date(start.getTime() - days * 86400000);
  const models = getModels();
  const current = await models.CrmConversation.findAll({
    where: { locationId: id, createdAt: { [Op.gte]: start } },
    attributes: ["id", "channel", "status", "createdAt", "closedAt", "dueAt"], raw: true,
  });
  const previousCount = await models.CrmConversation.count({ where: { locationId: id, createdAt: { [Op.gte]: previousStart, [Op.lt]: start } } });
  const workloadRows = await models.CrmConversation.findAll({
    where: { locationId: id, status: { [Op.in]: ["open", "pending"] } }, attributes: ["status", "dueAt"], raw: true,
  });
  const ids = current.map((row) => row.id);
  const messages = ids.length ? await models.CrmConversationMessage.findAll({
    where: { locationId: id, conversationId: { [Op.in]: ids }, direction: { [Op.in]: ["inbound", "outbound"] } },
    attributes: ["conversationId", "direction", "occurredAt"], order: [["occurredAt", "ASC"]], raw: true,
  }) : [];
  const timings = new Map();
  for (const message of messages) {
    const timing = timings.get(message.conversationId) || {};
    if (message.direction === "inbound" && !timing.inbound) timing.inbound = new Date(message.occurredAt);
    if (message.direction === "outbound" && timing.inbound && !timing.outbound) timing.outbound = new Date(message.occurredAt);
    timings.set(message.conversationId, timing);
  }
  const responseMs = (row) => {
    const timing = timings.get(row.id);
    return timing?.inbound && timing?.outbound ? timing.outbound - timing.inbound : null;
  };
  const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const responses = current.map(responseMs).filter(Number.isFinite);
  const resolved = current.filter((row) => row.closedAt || row.status === "resolved");
  const resolutions = resolved.map((row) => row.closedAt ? new Date(row.closedAt) - new Date(row.createdAt) : null).filter(Number.isFinite);
  const slaEligible = current.filter((row) => row.dueAt && Number.isFinite(responseMs(row)));
  const slaMetCount = slaEligible.filter((row) => new Date(row.createdAt).getTime() + responseMs(row) <= new Date(row.dueAt).getTime()).length;
  const dayKeys = Array.from({ length: days }, (_, index) => new Date(start.getTime() + (index + 1) * 86400000).toISOString().slice(0, 10));
  const volumeMap = new Map(dayKeys.map((key) => [key, 0]));
  current.forEach((row) => { const key = new Date(row.createdAt).toISOString().slice(0, 10); if (volumeMap.has(key)) volumeMap.set(key, volumeMap.get(key) + 1); });
  const channelLabels = { instagram: "Instagram", facebook: "Messenger", whatsapp: "WhatsApp", webchat: "Website Chat", email: "Email", sms: "SMS" };
  const channels = [...new Set(current.map((row) => row.channel))].map((channel) => {
    const rows = current.filter((row) => row.channel === channel);
    const channelResponses = rows.map(responseMs).filter(Number.isFinite);
    const channelResolved = rows.filter((row) => row.closedAt || row.status === "resolved");
    const channelResolution = channelResolved.map((row) => row.closedAt ? new Date(row.closedAt) - new Date(row.createdAt) : null).filter(Number.isFinite);
    const eligible = rows.filter((row) => row.dueAt && Number.isFinite(responseMs(row)));
    const met = eligible.filter((row) => new Date(row.createdAt).getTime() + responseMs(row) <= new Date(row.dueAt).getTime()).length;
    return { channel, label: channelLabels[channel] || channel, conversations: rows.length, firstResponse: durationLabel(average(channelResponses)), resolution: durationLabel(average(channelResolution)), slaPercent: eligible.length ? Math.round((met / eligible.length) * 1000) / 10 : null };
  });
  const changePercent = previousCount ? Math.round(((current.length - previousCount) / previousCount) * 1000) / 10 : null;
  return {
    period: { days, from: start.toISOString(), to: end.toISOString() },
    totals: { newConversations: current.length, previousCount, changePercent, firstResponse: durationLabel(average(responses)), resolved: resolved.length, resolutionRate: current.length ? Math.round((resolved.length / current.length) * 1000) / 10 : 0, slaPercent: slaEligible.length ? Math.round((slaMetCount / slaEligible.length) * 1000) / 10 : null },
    volume: [...volumeMap].map(([date, count]) => ({ date, count })),
    workload: { open: workloadRows.filter((row) => row.status === "open").length, pending: workloadRows.filter((row) => row.status === "pending").length, overdue: workloadRows.filter((row) => row.dueAt && new Date(row.dueAt) < end).length },
    channels,
  };
}

module.exports = {
  listChannels, listConversations, getConversation, listMessages, addInternalNote, updateAssignment, updateStatus, markRead,
  getWorkspace, updateWorkspace, listRoutingRules, createRoutingRule, updateRoutingRule, deleteRoutingRule,
  listSavedReplies, createSavedReply, updateSavedReply, deleteSavedReply,
  listAutomationRules, createAutomationRule, updateAutomationRule, deleteAutomationRule, getAnalytics,
  _internal: { CHANNEL_CATALOG, decodeCursor, encodeCursor, conversationCapabilities, locationId, cleanRouting, cleanPreferences },
};
