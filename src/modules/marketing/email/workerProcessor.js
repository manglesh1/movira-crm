const repository = require("./messageRepository");
const dispatcher = require("./messageDispatcher");
const rateLimiter = require("./sendRateLimiter");
const suppressionService = require("./suppressionService");
const warmupService = require("../../messaging-core/warmup/senderWarmupService");
const capacityService = require("../../messaging-core/capacity/providerCapacityService");

const TERMINAL_STATUSES = ["sent", "delivered", "bounced", "complained", "unsubscribed", "cancelled"];

class CampaignPausedError extends Error {
  constructor(campaignId) {
    super("Campaign is paused; message will remain queued for later retry.");
    this.name = "CampaignPausedError";
    this.code = "CAMPAIGN_PAUSED";
    this.campaignId = campaignId;
  }
}

async function processMarketingSqsMessage(sqsMessage) {
  const body = parseBody(sqsMessage.Body);
  if (!body.messageId) {
    throw new Error("SQS message missing messageId");
  }

  const message = await repository.findMessageById(body.messageId);
  if (!message) {
    return { skipped: true, reason: "message_not_found", messageId: body.messageId };
  }

  if (TERMINAL_STATUSES.includes(message.status)) {
    return {
      skipped: true,
      reason: `message_already_${message.status}`,
      messageId: message.id,
    };
  }

  const campaign = message.campaignId && message.getCampaign ? await message.getCampaign() : null;
  if (campaign?.status === "paused") {
    await repository.createDeliveryEvent({
      messageId: message.id,
      campaignId: message.campaignId,
      eventType: "campaign_paused",
      payload: { source: "marketing-worker", queueType: body.queueType || null },
    });
    throw new CampaignPausedError(campaign.id);
  }
  if (campaign?.status === "cancelled") {
    await message.update({
      status: "cancelled",
      metadata: {
        ...(message.metadata || {}),
        cancelledAt: new Date().toISOString(),
        cancelReason: "Campaign was cancelled before send.",
      },
    });
    await repository.createDeliveryEvent({
      messageId: message.id,
      campaignId: message.campaignId,
      eventType: "cancelled",
      payload: { source: "marketing-worker", reason: "campaign_cancelled" },
    });
    return { skipped: true, reason: "campaign_cancelled", messageId: message.id };
  }

  const suppression = await suppressionService.isSuppressed(message.locationId, message.recipient);
  if (suppression) {
    await message.update({
      status: "cancelled",
      metadata: {
        ...(message.metadata || {}),
        suppressedAt: new Date().toISOString(),
        suppressionId: suppression.id,
        suppressionReason: suppression.reason,
      },
    });
    await repository.createDeliveryEvent({
      messageId: message.id,
      campaignId: message.campaignId,
      eventType: "suppressed",
      payload: { source: "marketing-worker", suppressionId: suppression.id, reason: suppression.reason },
    });
    return { skipped: true, reason: "recipient_suppressed", messageId: message.id };
  }

  await rateLimiter.assertCanSend(message, { queueType: body.queueType || null });
  const capacity = await capacityService.reserveForMessage({ message, useCase: "marketing", messageType: "marketing" });
  const capacityReservation = capacity.reservation || null;
  if (capacity.alreadyAccepted && capacity.providerResult) {
    await repository.markSent(message, capacity.providerResult);
    return { skipped: true, reason: "provider_send_already_accepted", messageId: message.id, ...capacity.providerResult };
  }
  try {
    const warmupReservation = await warmupService.reserveForMessage({
      message,
      useCase: "marketing",
      recipient: message.recipient,
    });
    if (warmupReservation?.warmup) {
      await message.update({
        metadata: { ...(message.metadata || {}), warmup: warmupReservation.warmup },
      });
    }
  } catch (err) {
    await capacityService.release(capacityReservation, err.code || "warmup_rejected");
    throw err;
  }

  try {
    await repository.markSending(message);
    await repository.createDeliveryEvent({
      messageId: message.id,
      campaignId: message.campaignId,
      eventType: "sending",
      payload: { source: "marketing-worker", queueType: body.queueType || null },
    });

    const result = await dispatcher.dispatch(message);

    await capacityService.markAccepted(capacityReservation, result);

    await repository.markSent(message, result);
    await repository.createDeliveryEvent({
      messageId: message.id,
      campaignId: message.campaignId,
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      eventType: "sent",
      payload: { source: "marketing-worker", queueType: body.queueType || null },
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
      campaignId: message.campaignId,
      eventType: "failed",
      payload: {
        source: "marketing-worker",
        queueType: body.queueType || null,
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
  processMarketingSqsMessage,
  CampaignPausedError,
};
