const crypto = require("crypto");
const { getModels } = require("../../db/models");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = "invalid_inbound_email";
  return error;
}

function cleanEmail(value) {
  const match = String(value || "").trim().match(/<([^<>]+)>$/);
  const email = String(match ? match[1] : value || "").trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

function safeDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function threadKey(input, fromEmail) {
  const explicit = String(input.threadId || input.inReplyTo || input.references || "").trim();
  return explicit ? crypto.createHash("sha256").update(explicit).digest("hex").slice(0, 64) : fromEmail;
}

async function ingest(input = {}) {
  const locationId = Number(input.locationId || input.location_id);
  const fromEmail = cleanEmail(input.from?.email || input.from || input.sender);
  const toEmail = cleanEmail(input.to?.email || input.to || input.recipient);
  const providerMessageId = String(input.providerMessageId || input.messageId || input.message_id || "").trim().slice(0, 255);
  if (!Number.isInteger(locationId) || locationId < 1) throw invalid("locationId is required.");
  if (!fromEmail) throw invalid("A valid sender email is required.");
  if (!providerMessageId) throw invalid("providerMessageId is required for idempotency.");
  const textBody = String(input.text || input.textBody || "").trim().slice(0, 100000);
  const occurredAt = safeDate(input.receivedAt || input.timestamp);
  const models = getModels();

  return models.sequelize.transaction(async (transaction) => {
    const accountId = `email:${locationId}:${toEmail || "inbound"}`;
    const [connection] = await models.CrmConversationChannelConnection.findOrCreate({
      where: { locationId, channel: "email", provider: "movira", externalAccountId: accountId },
      defaults: {
        displayName: toEmail || "Email replies", status: "connected",
        capabilities: { sendMessages: true, receiveMessages: true, attachments: false },
        lastWebhookAt: occurredAt, lastHealthCheckAt: occurredAt,
      },
      transaction,
    });
    await connection.update({ status: "connected", lastWebhookAt: occurredAt, lastErrorCode: null, lastErrorMessageSafe: null }, { transaction });

    const existing = await models.CrmConversationMessage.findOne({ where: { connectionId: connection.id, providerMessageId }, transaction });
    if (existing) return { duplicate: true, messageId: existing.id, conversationId: existing.conversationId };

    const contact = await models.CrmContact.findOne({ where: { locationId, normalizedEmail: fromEmail }, transaction });
    const [identity] = await models.CrmConversationIdentity.findOrCreate({
      where: { connectionId: connection.id, externalUserId: fromEmail },
      defaults: {
        locationId, contactId: contact?.id || null, channel: "email", handle: fromEmail,
        displayName: String(input.from?.name || input.senderName || contact?.fullName || fromEmail).slice(0, 255),
        matchMethod: contact ? "email_exact" : "unmatched", matchConfidence: contact ? 1 : 0,
        linkedAt: contact ? new Date() : null, lastSeenAt: occurredAt,
      },
      transaction,
    });
    await identity.update({ contactId: contact?.id || identity.contactId, lastSeenAt: occurredAt }, { transaction });

    const externalThreadId = threadKey(input, fromEmail);
    const [conversation] = await models.CrmConversation.findOrCreate({
      where: { connectionId: connection.id, externalThreadId },
      defaults: {
        locationId, identityId: identity.id, contactId: contact?.id || null, channel: "email", status: "open",
        subject: String(input.subject || "Email conversation").slice(0, 500), lastMessageAt: occurredAt,
        lastInboundAt: occurredAt, unreadCount: 0, metadataSafe: { recipient: toEmail, recipientEmail: fromEmail },
      },
      transaction,
    });
    const message = await models.CrmConversationMessage.create({
      locationId, conversationId: conversation.id, connectionId: connection.id, senderIdentityId: identity.id,
      direction: "inbound", messageType: input.html && !textBody ? "html" : "text", textBody: textBody || stripHtml(input.html),
      attachments: [], providerMessageId, status: "received", occurredAt, providerCreatedAt: occurredAt,
      metadataSafe: { subject: String(input.subject || "").slice(0, 500), hasHtml: Boolean(input.html) },
    }, { transaction });
    await conversation.update({
      identityId: identity.id, contactId: contact?.id || conversation.contactId, status: "open", closedAt: null,
      subject: String(input.subject || conversation.subject || "Email conversation").slice(0, 500),
      lastMessageId: message.id, lastMessageDirection: "inbound", lastMessageAt: occurredAt, lastInboundAt: occurredAt,
      unreadCount: Number(conversation.unreadCount || 0) + 1,
      metadataSafe: { ...(conversation.metadataSafe || {}), recipient: toEmail, recipientEmail: fromEmail },
    }, { transaction });
    await models.CrmConversationMessageEvent.create({ locationId, messageId: message.id, eventType: "received", occurredAt, metadataSafe: {} }, { transaction });
    await models.CrmConversationOutbox.create({
      locationId, aggregateType: "conversation_message", aggregateId: message.id,
      eventType: "conversation.message.received", payloadSafe: { conversationId: conversation.id, messageId: message.id, channel: "email" },
      status: "completed", processedAt: new Date(),
    }, { transaction });
    return { duplicate: false, messageId: message.id, conversationId: conversation.id, contactId: contact?.id || null };
  });
}

function stripHtml(value) {
  return String(value || "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 100000);
}

module.exports = { ingest, _internal: { cleanEmail, threadKey, stripHtml } };
