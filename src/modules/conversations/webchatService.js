const crypto = require("crypto");
const { Op } = require("sequelize");
const { getModels } = require("../../db/models");
const { encryptJson, decryptJson } = require("../../shared/credentialVault");

const DEFAULT_SETTINGS = Object.freeze({
  greeting: "Hi! How can we help?",
  introText: "Start a conversation with our team.",
  launcherLabel: "Chat with us",
  messagePlaceholder: "Type your message…",
  launcherStyle: "pill",
  accentColor: "#7220e6",
  position: "right",
  allowedOrigins: [],
  nameField: "required",
  emailField: "required",
  phoneField: "hidden",
  locationCountry: "Canada",
  collectName: true,
  collectEmail: true,
  collectPhone: false,
});

const LAUNCHER_STYLES = new Set(["pill", "compact", "bubble", "square", "text", "outline", "status", "tab"]);
const VISITOR_FIELD_MODES = new Set(["hidden", "optional", "required"]);

function serviceError(message, statusCode = 400, code = "invalid_request") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function requiredLocationId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw serviceError("locationId is required.", 400, "location_id_required");
  return id;
}

function cleanText(value, max, fallback = "") {
  const text = String(value ?? "").trim();
  return (text || fallback).slice(0, max);
}

function normalizeOrigin(value) {
  const input = cleanText(value, 500);
  if (!input) return null;
  try {
    const parsed = new URL(input);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function normalizeFieldMode(value, legacyEnabled, fallback) {
  if (VISITOR_FIELD_MODES.has(value)) return value;
  if (legacyEnabled === false) return "hidden";
  if (legacyEnabled === true) return "required";
  return fallback;
}

function normalizeSettings(input = {}) {
  const origins = Array.isArray(input.allowedOrigins) ? input.allowedOrigins : [];
  const allowedOrigins = [...new Set(origins.map(normalizeOrigin).filter(Boolean))].slice(0, 25);
  const accentColor = /^#[0-9a-fA-F]{6}$/.test(String(input.accentColor || ""))
    ? String(input.accentColor)
    : DEFAULT_SETTINGS.accentColor;
  const nameField = normalizeFieldMode(input.nameField, input.collectName, DEFAULT_SETTINGS.nameField);
  const emailField = normalizeFieldMode(input.emailField, input.collectEmail, DEFAULT_SETTINGS.emailField);
  const phoneField = normalizeFieldMode(input.phoneField, input.collectPhone, DEFAULT_SETTINGS.phoneField);
  return {
    greeting: cleanText(input.greeting, 160, DEFAULT_SETTINGS.greeting),
    introText: cleanText(input.introText, 160, DEFAULT_SETTINGS.introText),
    launcherLabel: cleanText(input.launcherLabel, 40, DEFAULT_SETTINGS.launcherLabel),
    messagePlaceholder: cleanText(input.messagePlaceholder, 80, DEFAULT_SETTINGS.messagePlaceholder),
    launcherStyle: LAUNCHER_STYLES.has(input.launcherStyle) ? input.launcherStyle : DEFAULT_SETTINGS.launcherStyle,
    accentColor,
    position: input.position === "left" ? "left" : "right",
    allowedOrigins,
    nameField,
    emailField,
    phoneField,
    locationCountry: cleanText(input.locationCountry, 100, DEFAULT_SETTINGS.locationCountry),
    collectName: nameField !== "hidden",
    collectEmail: emailField !== "hidden",
    collectPhone: phoneField !== "hidden",
  };
}

function requiredSettings(input = {}) {
  const settings = normalizeSettings(input);
  if (!settings.allowedOrigins.length) {
    throw serviceError("Add at least one allowed website origin, including https://.", 400, "webchat_origin_required");
  }
  return settings;
}

function encryptSettings(input) {
  try {
    return encryptJson({ settings: requiredSettings(input) });
  } catch (error) {
    if (/encryption key|32-byte key|credential key/i.test(String(error?.message || ""))) {
      throw serviceError(
        "Web chat security configuration is unavailable. Ask a Movira administrator to check the credential encryption key.",
        503,
        "credential_encryption_unavailable",
      );
    }
    throw error;
  }
}

function settingsFor(connection) {
  if (!connection?.encryptedCredentials) return { ...DEFAULT_SETTINGS };
  try {
    return normalizeSettings(decryptJson(connection.encryptedCredentials).settings || {});
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function publicConnection(connection) {
  return {
    id: connection.id,
    channel: connection.channel,
    provider: connection.provider,
    externalAccountId: connection.externalAccountId,
    displayName: connection.displayName,
    status: connection.status,
    capabilities: connection.capabilities,
    settings: settingsFor(connection),
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

async function configure({ locationId, userId, settings = {}, displayName }) {
  const id = requiredLocationId(locationId);
  const models = getModels();
  let connection = await models.CrmConversationChannelConnection.findOne({
    where: { locationId: id, channel: "webchat", provider: "movira", status: { [Op.ne]: "disconnected" } },
    order: [["createdAt", "DESC"]],
  });
  const values = {
    locationId: id,
    channel: "webchat",
    provider: "movira",
    displayName: cleanText(displayName, 255, "Website Chat"),
    status: "connected",
    encryptedCredentials: encryptSettings(settings),
    capabilities: { receiveMessages: true, sendMessages: true, attachments: false, readReceipts: false },
    grantedScopes: [],
    connectedByUserId: userId || null,
    disconnectedAt: null,
    lastErrorCode: null,
    lastErrorMessageSafe: null,
  };
  if (connection) await connection.update(values);
  else connection = await models.CrmConversationChannelConnection.create({
    ...values,
    externalAccountId: `wc_${crypto.randomBytes(18).toString("base64url")}`,
  });
  return publicConnection(connection);
}

async function updateConfiguration({ connectionId, locationId, settings, displayName }) {
  const id = requiredLocationId(locationId);
  const { CrmConversationChannelConnection } = getModels();
  const connection = await CrmConversationChannelConnection.findOne({
    where: { id: connectionId, locationId: id, channel: "webchat", provider: "movira" },
  });
  if (!connection) throw serviceError("Web chat connection not found.", 404, "webchat_connection_not_found");
  await connection.update({
    displayName: cleanText(displayName, 255, connection.displayName || "Website Chat"),
    encryptedCredentials: encryptSettings(settings || settingsFor(connection)),
    status: "connected",
    disconnectedAt: null,
  });
  return publicConnection(connection);
}

async function findPublicConnection(widgetKey) {
  const { CrmConversationChannelConnection } = getModels();
  const connection = await CrmConversationChannelConnection.findOne({
    where: { externalAccountId: cleanText(widgetKey, 255), channel: "webchat", provider: "movira", status: "connected" },
  });
  if (!connection) throw serviceError("Chat widget not found.", 404, "webchat_widget_not_found");
  return connection;
}

function assertOriginAllowed(connection, requestOrigin) {
  const origin = normalizeOrigin(requestOrigin);
  const allowed = settingsFor(connection).allowedOrigins;
  if (!origin || !allowed.length || allowed.includes(origin)) return origin;
  throw serviceError("This website is not allowed to use the chat widget.", 403, "webchat_origin_not_allowed");
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function safeVisitor(input = {}, locationCountry = "Canada") {
  const email = cleanText(input.email, 320).toLowerCase();
  const rawPhone = cleanText(input.phone, 30);
  const phone = rawPhone ? require("../../utils/phoneNumber").normalizePhoneNumber(rawPhone, locationCountry) : null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw serviceError("Enter a valid email address.", 400, "invalid_email");
  if (rawPhone && !phone) throw serviceError(`Enter a valid phone number for ${locationCountry}.`, 400, "invalid_phone");
  return {
    name: cleanText(input.name, 120, "Website visitor"),
    email,
    phone,
    pageUrl: cleanText(input.pageUrl, 1000),
  };
}

function enforceVisitorRequirements(settings, input, safe) {
  if (settings.nameField === "required" && !cleanText(input.name, 120)) {
    throw serviceError("Name is required to start this chat.", 400, "visitor_name_required");
  }
  if (settings.emailField === "required" && !safe.email) {
    throw serviceError("Email is required to start this chat.", 400, "visitor_email_required");
  }
  if (settings.phoneField === "required" && !safe.phone) {
    throw serviceError("Phone is required to start this chat.", 400, "visitor_phone_required");
  }
}

async function startSession({ widgetKey, origin, visitor = {}, sessionToken }) {
  const connection = await findPublicConnection(widgetKey);
  assertOriginAllowed(connection, origin);
  const settings = settingsFor(connection);
  const models = getModels();
  if (sessionToken) {
    const existing = await models.CrmConversation.findOne({
      where: { connectionId: connection.id, "metadataSafe.sessionTokenHash": tokenHash(sessionToken) },
    });
    if (existing) return { sessionToken, conversationId: existing.id, visitor: existing.metadataSafe?.visitor || safeVisitor(visitor, settings.locationCountry) };
  }

  const safe = safeVisitor(visitor, settings.locationCountry);
  enforceVisitorRequirements(settings, visitor, safe);
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const externalUserId = `visitor_${crypto.randomBytes(16).toString("base64url")}`;
  const externalThreadId = `thread_${crypto.randomBytes(16).toString("base64url")}`;
  return models.sequelize.transaction(async (transaction) => {
    const identity = await models.CrmConversationIdentity.create({
      locationId: connection.locationId,
      connectionId: connection.id,
      channel: "webchat",
      externalUserId,
      displayName: safe.name,
      handle: safe.email || safe.phone || "Website visitor",
      profileMetadataSafe: { email: safe.email || null, phone: safe.phone || null, firstPageUrl: safe.pageUrl || null },
      matchMethod: safe.email ? "webchat_email_unverified" : safe.phone ? "webchat_phone_unverified" : "webchat_anonymous",
      lastSeenAt: new Date(),
    }, { transaction });
    const conversation = await models.CrmConversation.create({
      locationId: connection.locationId,
      connectionId: connection.id,
      identityId: identity.id,
      externalThreadId,
      channel: "webchat",
      status: "open",
      subject: safe.pageUrl ? `Website chat · ${safe.pageUrl}`.slice(0, 500) : "Website chat",
      metadataSafe: { sessionTokenHash: tokenHash(rawToken), visitor: safe, origin: normalizeOrigin(origin) },
    }, { transaction });
    return { sessionToken: rawToken, conversationId: conversation.id, visitor: safe };
  });
}

async function authenticatedSession(widgetKey, sessionToken, origin) {
  const connection = await findPublicConnection(widgetKey);
  assertOriginAllowed(connection, origin);
  const { CrmConversation } = getModels();
  const conversation = await CrmConversation.findOne({
    where: { connectionId: connection.id, "metadataSafe.sessionTokenHash": tokenHash(sessionToken) },
  });
  if (!conversation) throw serviceError("Chat session is invalid or expired.", 401, "invalid_webchat_session");
  return { connection, conversation };
}

async function addVisitorMessage({ widgetKey, sessionToken, origin, textBody, idempotencyKey }) {
  const text = cleanText(textBody, 2000);
  if (!text) throw serviceError("Message text is required.", 400, "message_text_required");
  const { connection, conversation } = await authenticatedSession(widgetKey, sessionToken, origin);
  const models = getModels();
  const key = cleanText(idempotencyKey, 200);
  if (key) {
    const duplicate = await models.CrmConversationMessage.findOne({ where: { locationId: connection.locationId, idempotencyKey: key } });
    if (duplicate) return duplicate;
  }
  const occurredAt = new Date();
  return models.sequelize.transaction(async (transaction) => {
    const message = await models.CrmConversationMessage.create({
      locationId: connection.locationId,
      conversationId: conversation.id,
      connectionId: connection.id,
      senderIdentityId: conversation.identityId,
      direction: "inbound",
      messageType: "text",
      textBody: text,
      status: "received",
      occurredAt,
      idempotencyKey: key || null,
      metadataSafe: { source: "webchat" },
    }, { transaction });
    await conversation.update({
      status: "open",
      lastMessageId: message.id,
      lastMessageDirection: "inbound",
      lastMessageAt: occurredAt,
      lastInboundAt: occurredAt,
      unreadCount: Number(conversation.unreadCount || 0) + 1,
    }, { transaction });
    await models.CrmConversationIdentity.update({ lastSeenAt: occurredAt }, { where: { id: conversation.identityId }, transaction });
    await models.CrmConversationChannelConnection.update({ lastWebhookAt: occurredAt }, { where: { id: connection.id }, transaction });
    await models.CrmConversationOutbox.create({
      locationId: connection.locationId,
      aggregateType: "conversation_message",
      aggregateId: message.id,
      eventType: "conversation.message.received",
      payloadSafe: { conversationId: conversation.id, messageId: message.id, channel: "webchat" },
      status: "completed",
      processedAt: occurredAt,
    }, { transaction });
    return message;
  });
}

async function listVisitorMessages({ widgetKey, sessionToken, origin, after }) {
  const { conversation } = await authenticatedSession(widgetKey, sessionToken, origin);
  const where = { conversationId: conversation.id, direction: { [Op.in]: ["inbound", "outbound"] } };
  if (after && !Number.isNaN(Date.parse(after))) where.occurredAt = { [Op.gt]: new Date(after) };
  const { CrmConversationMessage } = getModels();
  const rows = await CrmConversationMessage.findAll({ where, order: [["occurredAt", "ASC"], ["id", "ASC"]], limit: 100 });
  return rows.map((row) => ({
    id: row.id,
    direction: row.direction,
    textBody: row.textBody,
    status: row.status,
    occurredAt: row.occurredAt,
  }));
}

async function getPublicConfig(widgetKey, origin) {
  const connection = await findPublicConnection(widgetKey);
  assertOriginAllowed(connection, origin);
  return { displayName: connection.displayName || "Chat with us", ...settingsFor(connection) };
}

module.exports = {
  configure,
  updateConfiguration,
  getPublicConfig,
  startSession,
  addVisitorMessage,
  listVisitorMessages,
  settingsFor,
  publicConnection,
  assertOriginAllowed,
  _internal: { normalizeSettings, normalizeOrigin, safeVisitor, tokenHash, enforceVisitorRequirements },
};
