const crypto = require("crypto");
const { Op } = require("sequelize");
const config = require("../../config");
const { getModels } = require("../../db/models");
const logger = require("../../shared/logger");
const { decryptJson } = require("../../shared/credentialVault");

const plusHours = (value, hours) => new Date(new Date(value).getTime() + hours * 60 * 60 * 1000);
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function normalizedAttachments(message = {}) {
  return (Array.isArray(message.attachments) ? message.attachments : []).slice(0, 20).map((attachment) => ({
    type: attachment?.type || "unknown",
    url: attachment?.payload?.url || null,
    stickerId: attachment?.payload?.sticker_id || null,
  }));
}

function eventId(entryId, event) {
  if (event?.message?.mid) return `message:${event.message.mid}`;
  if (event?.postback?.mid) return `postback:${event.postback.mid}`;
  return `event:${entryId}:${digest(event)}`;
}

function safePayload(event) {
  return {
    sender: event?.sender?.id || null,
    recipient: event?.recipient?.id || null,
    timestamp: event?.timestamp || null,
    message: event?.message ? {
      mid: event.message.mid || null,
      text: event.message.text || null,
      isEcho: event.message.is_echo === true,
      attachments: normalizedAttachments(event.message),
      replyToMid: event.message.reply_to?.mid || null,
    } : null,
    delivery: event?.delivery ? { mids: event.delivery.mids || [], watermark: event.delivery.watermark || null } : null,
    read: event?.read ? { mid: event.read.mid || null, watermark: event.read.watermark || null } : null,
    postback: event?.postback ? { mid: event.postback.mid || null, title: event.postback.title || null, payload: event.postback.payload || null } : null,
  };
}

function profileFields(channel) {
  return channel === "instagram"
    ? "id,name,username,profile_pic"
    : "id,name,first_name,last_name,profile_pic";
}

function normalizedProfile(channel, payload = {}) {
  const firstName = String(payload.first_name || "").trim();
  const lastName = String(payload.last_name || "").trim();
  const combinedName = [firstName, lastName].filter(Boolean).join(" ");
  const username = String(payload.username || "").trim();
  return {
    displayName: String(payload.name || combinedName || username || "").trim() || null,
    handle: username || null,
    avatarUrlCached: payload.profile_pic || payload.profile_picture_url || null,
    profileMetadataSafe: {
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
      profileSource: "meta_graph",
      channel,
    },
  };
}

async function fetchSenderProfile(connection, externalUserId, fetchImpl = fetch) {
  if (!connection?.encryptedCredentials || !externalUserId) return null;
  try {
    const credentials = decryptJson(connection.encryptedCredentials);
    if (!credentials?.accessToken) return null;
    const url = new URL(`https://graph.facebook.com/${config.integrations.meta.graphVersion}/${encodeURIComponent(String(externalUserId))}`);
    url.searchParams.set("fields", profileFields(connection.channel));
    url.searchParams.set("access_token", credentials.accessToken);
    const response = await fetchImpl(url);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      logger.warn({
        channel: connection.channel,
        externalAccountId: connection.externalAccountId,
        externalUserId: String(externalUserId),
        statusCode: response.status,
        metaErrorCode: payload.error?.code || null,
      }, "Meta sender profile lookup failed");
      return null;
    }
    return normalizedProfile(connection.channel, payload);
  } catch (err) {
    logger.warn({
      channel: connection?.channel,
      externalAccountId: connection?.externalAccountId,
      externalUserId: String(externalUserId),
      errorName: err.name,
    }, "Meta sender profile lookup failed");
    return null;
  }
}

async function processInboundMessage(models, connection, event, transaction, senderProfile = null) {
  const message = event.message;
  if (!message?.mid || message.is_echo === true || !event.sender?.id) return { type: "ignored" };
  const occurredAt = event.timestamp ? new Date(Number(event.timestamp)) : new Date();
  const senderId = String(event.sender.id);
  const [identity] = await models.CrmConversationIdentity.findOrCreate({
    where: { connectionId: connection.id, externalUserId: senderId },
    defaults: {
      locationId: connection.locationId,
      channel: connection.channel,
      lastSeenAt: occurredAt,
      ...(senderProfile || {}),
    },
    transaction,
  });
  const identityUpdates = {};
  if (!identity.lastSeenAt || new Date(identity.lastSeenAt) < occurredAt) identityUpdates.lastSeenAt = occurredAt;
  if (senderProfile && (!identity.displayName || !identity.avatarUrlCached || (senderProfile.handle && !identity.handle))) {
    Object.assign(identityUpdates, senderProfile);
  }
  if (Object.keys(identityUpdates).length) await identity.update(identityUpdates, { transaction });

  let conversation = await models.CrmConversation.findOne({
    where: { connectionId: connection.id, externalThreadId: senderId }, transaction, lock: transaction.LOCK.UPDATE,
  });
  if (!conversation) {
    conversation = await models.CrmConversation.create({
      locationId: connection.locationId, connectionId: connection.id, identityId: identity.id,
      contactId: identity.contactId || null, externalThreadId: senderId, channel: connection.channel,
      status: "open", lastMessageAt: occurredAt, lastInboundAt: occurredAt,
      replyWindowClosesAt: plusHours(occurredAt, 24), unreadCount: 0,
    }, { transaction });
  }

  const [storedMessage, created] = await models.CrmConversationMessage.findOrCreate({
    where: { connectionId: connection.id, providerMessageId: String(message.mid) },
    defaults: {
      locationId: connection.locationId, conversationId: conversation.id, senderIdentityId: identity.id,
      direction: "inbound", messageType: message.attachments?.length ? "attachment" : "text",
      textBody: message.text || null, attachments: normalizedAttachments(message), status: "received",
      occurredAt, providerCreatedAt: occurredAt, metadataSafe: { replyToProviderMessageId: message.reply_to?.mid || null },
    }, transaction,
  });
  if (!created) return { type: "duplicate", conversationId: conversation.id, messageId: storedMessage.id };

  await conversation.update({
    identityId: identity.id, contactId: identity.contactId || conversation.contactId,
    status: ["resolved", "snoozed"].includes(conversation.status) ? "open" : conversation.status,
    lastMessageId: storedMessage.id, lastMessageDirection: "inbound", lastMessageAt: occurredAt,
    lastInboundAt: occurredAt, replyWindowClosesAt: plusHours(occurredAt, 24), snoozedUntil: null,
    closedAt: null, unreadCount: Number(conversation.unreadCount || 0) + 1,
  }, { transaction });
  await models.CrmConversationOutbox.create({
    locationId: connection.locationId, aggregateType: "conversation", aggregateId: conversation.id,
    eventType: "conversation.message.received",
    payloadSafe: { conversationId: conversation.id, messageId: storedMessage.id, channel: connection.channel },
  }, { transaction });
  return { type: "message", conversationId: conversation.id, messageId: storedMessage.id };
}

async function processReceipt(models, connection, event, transaction) {
  const recordStatus = async (message, status, occurredAt) => {
    const rank = { queued: 0, retrying: 0, sent: 1, delivered: 2, read: 3 };
    if ((rank[message.status] ?? -1) >= rank[status]) return false;
    await message.update({ status }, { transaction });
    await models.CrmConversationMessageEvent.create({
      locationId: connection.locationId, messageId: message.id, eventType: status,
      occurredAt, metadataSafe: {},
    }, { transaction });
    await models.CrmConversationOutbox.create({
      locationId: connection.locationId, aggregateType: "conversation_message", aggregateId: message.id,
      eventType: `conversation.message.${status}`,
      payloadSafe: { conversationId: message.conversationId, messageId: message.id, status },
      status: "completed", processedAt: new Date(),
    }, { transaction });
    return true;
  };
  const occurredAt = event.timestamp ? new Date(Number(event.timestamp)) : new Date();
  const deliveryMids = Array.isArray(event.delivery?.mids) ? event.delivery.mids.map(String) : [];
  if (deliveryMids.length) {
    const messages = await models.CrmConversationMessage.findAll({
      where: { connectionId: connection.id, providerMessageId: { [Op.in]: deliveryMids } }, transaction,
    });
    let count = 0;
    for (const message of messages) {
      if (await recordStatus(message, "delivered", occurredAt)) count += 1;
    }
    return { type: "delivery", count };
  }
  const readMid = event.read?.mid ? String(event.read.mid) : null;
  if (readMid) {
    const message = await models.CrmConversationMessage.findOne({
      where: { connectionId: connection.id, direction: "outbound", providerMessageId: readMid }, transaction,
    });
    const count = message && await recordStatus(message, "read", occurredAt) ? 1 : 0;
    return { type: "read", count };
  }
  const watermark = Number(event.read?.watermark);
  if (Number.isFinite(watermark)) {
    const messages = await models.CrmConversationMessage.findAll({
      where: {
        connectionId: connection.id, direction: "outbound",
        status: { [Op.in]: ["sent", "delivered"] }, occurredAt: { [Op.lte]: new Date(watermark) },
      },
      transaction,
    });
    let count = 0;
    for (const message of messages) {
      if (await recordStatus(message, "read", occurredAt)) count += 1;
    }
    return { type: "read", count };
  }
  return { type: "ignored" };
}

async function processEvent(connection, entryId, event) {
  const models = getModels();
  const providerEventId = eventId(entryId, event);
  const payloadSafe = safePayload(event);
  const [webhook, created] = await models.CrmConversationWebhookEvent.findOrCreate({
    where: { connectionId: connection.id, providerEventId },
    defaults: {
      locationId: connection.locationId, provider: "meta", eventType: event.message ? "message" : (event.delivery ? "delivery" : (event.read ? "read" : "other")),
      payloadHash: digest(event), payloadSafe, status: "pending", attemptCount: 0,
    },
  });
  if (!created && webhook.status === "processed") return { type: "duplicate" };
  try {
    let senderProfile = null;
    if (event.message && event.message.is_echo !== true && event.sender?.id) {
      const existingIdentity = await models.CrmConversationIdentity.findOne({
        where: { connectionId: connection.id, externalUserId: String(event.sender.id) },
        attributes: ["displayName", "handle", "avatarUrlCached"],
      });
      if (!existingIdentity?.displayName || !existingIdentity?.avatarUrlCached) {
        senderProfile = await fetchSenderProfile(connection, event.sender.id);
      }
    }
    const result = await models.sequelize.transaction(async (transaction) => {
      const processed = event.message
        ? await processInboundMessage(models, connection, event, transaction, senderProfile)
        : await processReceipt(models, connection, event, transaction);
      await webhook.update({ status: "processed", processedAt: new Date(), attemptCount: webhook.attemptCount + 1, lastErrorCode: null, lastErrorMessageSafe: null }, { transaction });
      return processed;
    });
    return result;
  } catch (err) {
    await webhook.update({
      status: "failed", attemptCount: webhook.attemptCount + 1, nextAttemptAt: new Date(Date.now() + 60_000),
      lastErrorCode: err.name || "processing_failed", lastErrorMessageSafe: String(err.message || "Processing failed").slice(0, 1000),
    }).catch(() => {});
    throw err;
  }
}

async function handleWebhook(payload = {}) {
  const models = getModels();
  const results = [];
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  logger.info({
    webhookObject: String(payload.object || "unknown"),
    entryIds: entries.map((entry) => String(entry?.id || "")).filter(Boolean),
    entryCount: entries.length,
  }, "Meta webhook received");
  for (const entry of entries) {
    const entryId = String(entry?.id || "");
    if (!entryId) continue;
    const connection = await models.CrmConversationChannelConnection.findOne({
      where: { provider: "meta", externalAccountId: entryId, status: "connected" },
    });
    if (!connection) {
      logger.warn({ webhookObject: String(payload.object || "unknown"), entryId }, "Meta webhook account was not matched");
      results.push({ entryId, type: "unmatched_account" });
      continue;
    }
    logger.info({ webhookObject: String(payload.object || "unknown"), entryId, channel: connection.channel }, "Meta webhook account matched");
    await connection.update({ lastWebhookAt: new Date(), lastHealthCheckAt: new Date() });
    for (const event of Array.isArray(entry.messaging) ? entry.messaging : []) {
      results.push({ entryId, ...(await processEvent(connection, entryId, event)) });
    }
  }
  return { accepted: results.length, results };
}

module.exports = {
  handleWebhook,
  _internal: { eventId, safePayload, normalizedAttachments, plusHours, profileFields, normalizedProfile, fetchSenderProfile, processReceipt },
};
