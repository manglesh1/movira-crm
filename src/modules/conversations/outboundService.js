const { Op } = require("sequelize");
const config = require("../../config");
const { getModels } = require("../../db/models");
const { decryptJson } = require("../../shared/credentialVault");
const metaProvider = require("./metaMessagingProvider");
const emailProvider = require("../messaging-core/providers/emailProviderRouter");

function error(message, statusCode = 400, code = "invalid_request") {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function normalizeIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!key) throw error("Idempotency-Key header is required.", 400, "idempotency_key_required");
  if (key.length > 200 || !/^[a-zA-Z0-9._:-]+$/.test(key)) throw error("Idempotency key is invalid.", 400, "invalid_idempotency_key");
  return key;
}

function validateReply(conversation, connection, now = new Date()) {
  if (connection?.status !== "connected") throw error("This channel is not connected.", 409, "channel_not_connected");
  if (connection?.capabilities?.sendMessages !== true) throw error("This channel cannot send messages.", 409, "provider_send_not_supported");
  if (conversation.replyWindowClosesAt && new Date(conversation.replyWindowClosesAt) <= now) {
    throw error("The customer reply window has closed.", 409, "reply_window_closed");
  }
  if (!conversation.externalThreadId) throw error("The provider recipient is unavailable.", 409, "recipient_unavailable");
}

function metaSenderAccountId(connection, credentials = {}) {
  if (connection?.channel === "instagram") {
    if (!credentials.parentPageId) {
      throw error("The linked Facebook Page is unavailable. Reconnect Instagram.", 409, "instagram_parent_page_missing");
    }
    return String(credentials.parentPageId);
  }
  return connection?.externalAccountId ? String(connection.externalAccountId) : null;
}

async function queueReply(conversationId, input, actorUserId, idempotencyHeader) {
  const locationId = Number(input.locationId);
  if (!Number.isInteger(locationId) || locationId < 1) throw error("locationId is required.");
  const textBody = String(input.textBody || "").trim();
  if (!textBody) throw error("Message text is required.", 400, "message_text_required");
  if (textBody.length > 2000) throw error("Message text must be 2,000 characters or fewer.", 400, "message_text_too_long");
  if (input.attachments?.length) throw error("Attachments are not supported by this channel yet.", 422, "attachments_not_supported");
  const idempotencyKey = normalizeIdempotencyKey(idempotencyHeader || input.idempotencyKey);
  const models = getModels();

  const existing = await models.CrmConversationMessage.findOne({ where: { locationId, idempotencyKey } });
  if (existing) {
    if (existing.conversationId !== conversationId) throw error("This idempotency key was already used for another conversation.", 409, "idempotency_key_conflict");
    return { message: existing, duplicate: true };
  }

  try {
    return await models.sequelize.transaction(async (transaction) => {
      const conversation = await models.CrmConversation.findOne({
        where: { id: conversationId, locationId }, transaction, lock: transaction.LOCK.UPDATE,
      });
      if (!conversation) throw error("Conversation not found.", 404, "conversation_not_found");
      const connection = await models.CrmConversationChannelConnection.findOne({
        where: { id: conversation.connectionId, locationId }, transaction,
      });
      validateReply(conversation, connection);
      const occurredAt = new Date();
      const message = await models.CrmConversationMessage.create({
        locationId, conversationId, connectionId: connection.id, direction: "outbound", messageType: "text",
        textBody, attachments: [], idempotencyKey, status: "queued", sentByUserId: actorUserId || null,
        occurredAt, metadataSafe: {},
      }, { transaction });
      await conversation.update({
        lastMessageId: message.id, lastMessageDirection: "outbound", lastMessageAt: occurredAt,
      }, { transaction });
      await models.CrmConversationOutbox.create({
        locationId, aggregateType: "conversation_message", aggregateId: message.id,
        eventType: "conversation.message.send", payloadSafe: { conversationId, messageId: message.id, channel: connection.channel },
      }, { transaction });
      return { message, duplicate: false };
    });
  } catch (err) {
    if (err.name !== "SequelizeUniqueConstraintError") throw err;
    const duplicate = await models.CrmConversationMessage.findOne({ where: { locationId, idempotencyKey } });
    if (!duplicate || duplicate.conversationId !== conversationId) throw error("This idempotency key conflicts with another request.", 409, "idempotency_key_conflict");
    return { message: duplicate, duplicate: true };
  }
}

function retryDelayMs(attempt, random = Math.random) {
  const exponential = Math.min(15 * 60 * 1000, 2000 * 2 ** Math.max(0, attempt - 1));
  return exponential + Math.floor(exponential * 0.2 * random());
}

async function claimSendEvents({ workerId, limit = 10 }) {
  const models = getModels();
  const staleBefore = new Date(Date.now() - config.conversations.staleLockMs);
  await models.CrmConversationOutbox.update({ status: "pending", lockedAt: null }, {
    where: { eventType: "conversation.message.send", status: "processing", lockedAt: { [Op.lt]: staleBefore } },
  });
  const candidates = await models.CrmConversationOutbox.findAll({
    where: { eventType: "conversation.message.send", status: "pending", availableAt: { [Op.lte]: new Date() } },
    order: [["availableAt", "ASC"], ["createdAt", "ASC"]], limit,
  });
  const claimed = [];
  for (const row of candidates) {
    const [updated] = await models.CrmConversationOutbox.update({
      status: "processing", lockedAt: new Date(), lastErrorCode: null, lastErrorMessageSafe: null,
    }, { where: { id: row.id, status: "pending" } });
    if (updated) claimed.push(await models.CrmConversationOutbox.findByPk(row.id));
  }
  return claimed.filter(Boolean);
}

async function createStatusEvent(models, transaction, message, eventType, extra = {}) {
  await models.CrmConversationOutbox.create({
    locationId: message.locationId, aggregateType: "conversation_message", aggregateId: message.id,
    eventType, payloadSafe: { conversationId: message.conversationId, messageId: message.id, status: message.status, ...extra },
    status: "completed", processedAt: new Date(),
  }, { transaction });
}

async function processSendEvent(outbox, fetchImpl = fetch) {
  const models = getModels();
  const message = await models.CrmConversationMessage.findOne({ where: { id: outbox.aggregateId, locationId: outbox.locationId } });
  if (!message) {
    await outbox.update({ status: "failed", processedAt: new Date(), lockedAt: null, lastErrorCode: "message_not_found", lastErrorMessageSafe: "Queued message no longer exists." });
    return { failed: true, reason: "message_not_found" };
  }
  if (["sent", "delivered", "read"].includes(message.status)) {
    await outbox.update({ status: "completed", processedAt: new Date(), lockedAt: null });
    return { duplicate: true, messageId: message.id };
  }
  const conversation = await models.CrmConversation.findOne({ where: { id: message.conversationId, locationId: message.locationId } });
  const connection = conversation && await models.CrmConversationChannelConnection.findOne({ where: { id: conversation.connectionId, locationId: message.locationId } });
  try {
    validateReply(conversation || {}, connection);
    let sent;
    if (connection.provider === "movira" && connection.channel === "webchat") {
      // The browser widget polls the shared message store, so no external
      // provider delivery call is needed.
      sent = { providerMessageId: `webchat-${message.id}` };
    } else if (connection.provider === "movira" && connection.channel === "email") {
      const recipientEmail = conversation.metadataSafe?.recipientEmail || (conversation.externalThreadId.includes("@") ? conversation.externalThreadId : null);
      if (!recipientEmail) throw error("The email reply recipient is unavailable.", 409, "recipient_unavailable");
      sent = await emailProvider.sendTransactionalEmail({
        locationId: message.locationId,
        to: recipientEmail,
        subject: /^re:/i.test(conversation.subject || "") ? conversation.subject : `Re: ${conversation.subject || "Your message"}`,
        text: message.textBody,
        html: `<div style="white-space:pre-wrap;font-family:Arial,sans-serif">${escapeHtml(message.textBody)}</div>`,
        messageId: message.id,
      });
    } else if (connection.provider === "meta") {
      const credentials = decryptJson(connection.encryptedCredentials);
      sent = await metaProvider.sendText({
        // Instagram accounts connected through Facebook Login use the linked
        // Page as the Messenger send endpoint. The IG business id remains the
        // connection identity used to match inbound webhook entries.
        externalAccountId: metaSenderAccountId(connection, credentials),
        recipientId: conversation.externalThreadId,
        text: message.textBody,
        accessToken: credentials.accessToken,
      }, fetchImpl);
    } else {
      throw error("No outbound adapter is available for this provider.", 409, "provider_adapter_unavailable");
    }
    await models.sequelize.transaction(async (transaction) => {
      await message.update({ status: "sent", providerMessageId: sent.providerMessageId, failureCode: null, failureMessageSafe: null }, { transaction });
      await conversation.update({ lastOutboundAt: new Date() }, { transaction });
      await models.CrmConversationMessageEvent.create({
        locationId: message.locationId, messageId: message.id, eventType: "sent", occurredAt: new Date(),
        metadataSafe: { providerMessageId: sent.providerMessageId },
      }, { transaction });
      await outbox.update({ status: "completed", processedAt: new Date(), lockedAt: null, attemptCount: Number(outbox.attemptCount || 0) + 1 }, { transaction });
      await createStatusEvent(models, transaction, message, "conversation.message.sent");
    });
    return { sent: true, messageId: message.id, providerMessageId: sent.providerMessageId };
  } catch (err) {
    const attempts = Number(outbox.attemptCount || 0) + 1;
    const retry = err.retryable === true && attempts < config.conversations.outboundMaxAttempts;
    await models.sequelize.transaction(async (transaction) => {
      await message.update({
        status: retry ? "retrying" : "failed", failureCode: err.code || "send_failed",
        failureMessageSafe: String(err.message || "Message send failed.").slice(0, 1000),
      }, { transaction });
      await outbox.update({
        status: retry ? "pending" : "failed", attemptCount: attempts, lockedAt: null,
        availableAt: retry ? new Date(Date.now() + retryDelayMs(attempts)) : outbox.availableAt,
        processedAt: retry ? null : new Date(), lastErrorCode: err.code || "send_failed",
        lastErrorMessageSafe: String(err.message || "Message send failed.").slice(0, 1000),
      }, { transaction });
      await createStatusEvent(models, transaction, message, retry ? "conversation.message.retrying" : "conversation.message.failed", { attempt: attempts });
    });
    if (retry) return { retrying: true, messageId: message.id, attempt: attempts };
    return { failed: true, messageId: message.id, attempt: attempts, reason: err.code || "send_failed" };
  }
}

function escapeHtml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function encodeEventCursor(row) {
  return Buffer.from(JSON.stringify({ at: new Date(row.createdAt).toISOString(), id: row.id })).toString("base64url");
}

function decodeEventCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (!parsed.id || Number.isNaN(Date.parse(parsed.at))) throw new Error("invalid");
    return { id: String(parsed.id), at: new Date(parsed.at) };
  } catch {
    throw error("Event cursor is invalid.", 400, "invalid_event_cursor");
  }
}

async function listEvents(input) {
  const locationId = Number(input.locationId);
  if (!Number.isInteger(locationId) || locationId < 1) throw error("locationId is required.");
  const limit = Math.min(100, Math.max(1, Number(input.limit) || 50));
  const cursor = decodeEventCursor(input.cursor);
  const where = { locationId };
  if (cursor) where[Op.or] = [{ createdAt: { [Op.gt]: cursor.at } }, { createdAt: cursor.at, id: { [Op.gt]: cursor.id } }];
  const { CrmConversationOutbox } = getModels();
  const rows = await CrmConversationOutbox.findAll({ where, order: [["createdAt", "ASC"], ["id", "ASC"]], limit: limit + 1 });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => ({ id: row.id, eventType: row.eventType, aggregateType: row.aggregateType, aggregateId: row.aggregateId, payload: row.payloadSafe, createdAt: row.createdAt })),
    pageInfo: { hasMore, nextCursor: page.length ? encodeEventCursor(page[page.length - 1]) : (input.cursor || null) },
  };
}

module.exports = {
  queueReply, claimSendEvents, processSendEvent, listEvents,
  _internal: { normalizeIdempotencyKey, validateReply, retryDelayMs, encodeEventCursor, decodeEventCursor, metaSenderAccountId },
};
