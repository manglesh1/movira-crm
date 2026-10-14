const { getModels } = require("../../db/models");
const { callCore } = require("./guestAiBridge");
const { settingsFor } = require("./webchatService");

function mayPublish(conversation, connection, event) {
  const settings = settingsFor(connection);
  return connection.status === "connected" && settings.enabled && settings.aiEnabled
    && conversation.handlingMode === "ai" && conversation.status === "open"
    && conversation.handlingVersion === event.payloadSafe.handlingVersion
    && conversation.lastMessageId === event.payloadSafe.messageId;
}

async function takeOver(id, locationId, mode = "human", actorUserId = null) {
  if (actorUserId) await require('./assigneeService').validateAssignee(locationId, actorUserId);
  const models = getModels();
  return models.sequelize.transaction(async (transaction) => {
    const row = await models.CrmConversation.findOne({ where: { id, locationId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!row) throw Object.assign(new Error("Conversation not found."), { statusCode: 404 });
    if (row.status === 'spam') throw Object.assign(new Error('This conversation is blocked. Staff must reopen it first.'), { statusCode: 409 });
    // Visitors cannot move a conversation already owned by an agent back to waiting.
    if (row.handlingMode === "human" && mode === "waiting") return row;
    await row.update({ handlingMode: mode, handlingVersion: row.handlingVersion + 1,
      ...(actorUserId ? { assignedUserId: actorUserId } : {}) }, { transaction });
    await models.CrmConversationOutbox.create({ locationId, aggregateType: "conversation", aggregateId: id,
      eventType: "conversation.handoff", payloadSafe: { conversationId: id, handlingMode: mode }, status: "completed", processedAt: new Date() }, { transaction });
    return row;
  });
}

async function returnToAi(id, locationId, actorUserId) {
  const models = getModels();
  const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };
  const initial = await models.CrmConversation.findOne({ where: { id, locationId } });
  if (!initial) fail("Conversation not found.", 404);
  if (initial.channel !== "webchat") fail("Guest AI is available for website chat only.");
  // Validate park readiness before taking database locks. Configuration is
  // checked again under lock so disabling AI cannot race with this action.
  await callCore("context", { locationId, requireAi: true });
  return models.sequelize.transaction(async transaction => {
    // Match the AI publisher's connection -> conversation lock order.
    const connection = await models.CrmConversationChannelConnection.findOne({
      where: { id: initial.connectionId, locationId }, transaction, lock: transaction.LOCK.UPDATE,
    });
    const settings = connection && settingsFor(connection);
    if (!connection || connection.status !== "connected" || !settings.enabled || !settings.aiEnabled) {
      fail("Enable Guest AI in Website Chat + Guest AI settings before sending this chat back to AI.");
    }
    const row = await models.CrmConversation.findOne({ where: { id, locationId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!row) fail("Conversation not found.", 404);
    if (row.status !== "open") fail("Reopen this conversation before sending it back to AI.");
    if (row.handlingMode === "ai") return row;
    const previousUserId = row.assignedUserId;
    await row.update({ handlingMode: "ai", handlingVersion: row.handlingVersion + 1, assignedUserId: null }, { transaction });
    await models.CrmConversationAssignment.create({ locationId, conversationId: id,
      fromTeamId: row.assignedTeamId, toTeamId: row.assignedTeamId,
      fromUserId: previousUserId, toUserId: null, assignedByUserId: actorUserId,
      reason: "Staff returned conversation to Guest AI",
    }, { transaction });
    await models.CrmConversationOutbox.create({ locationId, aggregateType: "conversation", aggregateId: id,
      eventType: "conversation.handoff", payloadSafe: { conversationId: id, handlingMode: "ai", actorUserId },
      status: "completed", processedAt: new Date(),
    }, { transaction });
    // Resume on the next guest message, never replay old questions or a
    // human-request message that would immediately hand off again.
    return row;
  });
}

async function processEvent(event) {
  const models = getModels();
  const conversation = await models.CrmConversation.findOne({ where: { id: event.aggregateId, locationId: event.locationId } });
  if (!conversation) return event.update({ status: "completed", processedAt: new Date(), lockedAt: null });
  if (event.eventType === "conversation.contact.sync") {
    await callCore("contact", { locationId: event.locationId, conversationId: conversation.id, visitor: conversation.metadataSafe?.visitor || {}, state: conversation.metadataSafe?.aiState || {} });
    return event.update({ status: "completed", processedAt: new Date(), lockedAt: null });
  }
  const connection = await models.CrmConversationChannelConnection.findByPk(conversation.connectionId);
  if (!connection || !mayPublish(conversation, connection, event)) {
    return event.update({ status: "completed", processedAt: new Date(), lockedAt: null });
  }
  const history = await models.CrmConversationMessage.findAll({
    where: { conversationId: conversation.id, direction: ["inbound", "outbound"] },
    order: [["occurredAt", "DESC"], ["id", "DESC"]], limit: 20,
  });
  const pendingQuestions = [];
  for (const message of history) {
    if (message.direction !== "inbound") break;
    pendingQuestions.unshift(message.textBody || "");
  }
  const question = pendingQuestions.join("\n").slice(-2000);
  let answer;
  try {
    answer = await callCore("reply", { locationId: event.locationId, conversationId: conversation.id, rateLimitKey: conversation.metadataSafe?.rateLimitKey, state: conversation.metadataSafe?.aiState || {},
      messages: [{ role: "user", content: question }] });
  } catch {
    answer = { handoff: true, message: settingsFor(connection).offlineMessage };
  }
  return models.sequelize.transaction(async (transaction) => {
    await connection.reload({ transaction, lock: transaction.LOCK.UPDATE });
    await conversation.reload({ transaction, lock: transaction.LOCK.UPDATE });
    await event.reload({ transaction, lock: transaction.LOCK.UPDATE });
    if (event.status !== "processing") return;
    if (mayPublish(conversation, connection, event)) {
      const message = await models.CrmConversationMessage.create({
        locationId: event.locationId, conversationId: conversation.id, connectionId: connection.id,
        direction: "outbound", messageType: "text", textBody: String(answer.message || "Please contact our team.").slice(0, 10000),
        authorType: answer.handoff ? "system" : "ai",
        status: "sent", occurredAt: new Date(), idempotencyKey: `ai:${event.id}`,
        metadataSafe: { author: answer.handoff ? "system" : "ai", cards: answer.cards || [], choices: answer.choices || [] },
      }, { transaction });
      await conversation.update({ lastMessageId: message.id, lastMessageDirection: "outbound", lastMessageAt: message.occurredAt,
        metadataSafe: { ...conversation.metadataSafe, aiState: answer.state || conversation.metadataSafe?.aiState || {}, ...(answer.handoff ? { handoffReason: answer.reason || "ai_unavailable" } : {}) },
        ...(answer.handoff ? { handlingMode: "waiting", handlingVersion: conversation.handlingVersion + 1 } : {}) }, { transaction });
      await models.CrmConversationOutbox.create({ locationId: event.locationId, aggregateType: "conversation", aggregateId: conversation.id,
        eventType: "conversation.contact.sync", payloadSafe: { conversationId: conversation.id } }, { transaction });
      await models.CrmConversationOutbox.create({ locationId: event.locationId, aggregateType: "conversation", aggregateId: conversation.id,
        eventType: "conversation.message.received", payloadSafe: { conversationId: conversation.id, messageId: message.id },
        status: "completed", processedAt: new Date() }, { transaction });
    }
    await event.update({ status: "completed", processedAt: new Date(), lockedAt: null }, { transaction });
  });
}

module.exports = { mayPublish, takeOver, returnToAi, processEvent };
