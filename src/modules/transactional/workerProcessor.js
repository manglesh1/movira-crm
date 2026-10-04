const repository = require("./repository");
const dispatcher = require("./dispatcher");
const { DELIVERY_EVENT, STATUS } = require("./constants");
const suppressionService = require("../marketing/email/suppressionService");
const warmupService = require("../messaging-core/warmup/senderWarmupService");
const capacityService = require("../messaging-core/capacity/providerCapacityService");

async function processTransactionalSqsMessage(sqsMessage) {
  const body = parseBody(sqsMessage.Body);
  if (!body.messageId) {
    throw new Error("SQS message missing messageId");
  }

  const message = await repository.findMessageById(body.messageId);
  if (!message) {
    return { skipped: true, reason: "message_not_found", messageId: body.messageId };
  }

  if ([STATUS.SENT, STATUS.DELIVERED, STATUS.CANCELLED].includes(message.status)) {
    return {
      skipped: true,
      reason: `message_already_${message.status}`,
      messageId: message.id,
    };
  }

  if (message.channel === "email") {
    const suppression = await suppressionService.isSuppressed(message.locationId, message.recipientAddress);
    if (suppression) {
      await repository.markSuppressed(message, suppression);
      return { skipped: true, reason: "recipient_suppressed", messageId: message.id };
    }
  }

  let capacityReservation = null;
  if (message.channel === "email") {
    const capacity = await capacityService.reserveForMessage({ message, useCase: "transactional", messageType: "transactional" });
    capacityReservation = capacity.reservation || null;
    if (capacity.alreadyAccepted && capacity.providerResult) {
      await repository.markSent(message, capacity.providerResult);
      return { skipped: true, reason: "provider_send_already_accepted", messageId: message.id, ...capacity.providerResult };
    }
    try {
      const warmupReservation = await warmupService.reserveForMessage({
        message,
        useCase: "transactional",
        recipient: message.recipientAddress,
      });
      if (warmupReservation?.warmup) {
        await message.update({
          payload: { ...(message.payload || {}), _warmup: warmupReservation.warmup },
        });
      }
    } catch (err) {
      await capacityService.release(capacityReservation, err.code || "warmup_rejected");
      throw err;
    }
  }

  try {
    await repository.markSending(message);
    await repository.createDeliveryEvent({
      messageId: message.id,
      eventType: DELIVERY_EVENT.SENDING,
      payload: { source: "transactional-worker" },
    });

    const result = await dispatcher.dispatch(message);

    await capacityService.markAccepted(capacityReservation, result);

    await repository.markSent(message, result);
    await repository.createDeliveryEvent({
      messageId: message.id,
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      eventType: DELIVERY_EVENT.SENT,
      payload: { source: "transactional-worker" },
    });

    return {
      skipped: false,
      messageId: message.id,
      provider: result.provider,
      providerMessageId: result.providerMessageId,
    };
  } catch (err) {
    await capacityService.release(capacityReservation, err.code || "send_failed");
    await repository.markFailed(message, err);
    await repository.createDeliveryEvent({
      messageId: message.id,
      eventType: DELIVERY_EVENT.FAILED,
      payload: {
        source: "transactional-worker",
        error: err.message,
      },
    });
    throw err;
  }
}

function parseBody(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  return JSON.parse(raw);
}

module.exports = {
  processTransactionalSqsMessage,
};
