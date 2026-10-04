const { getModels } = require("../../../db/models");
const suppressionService = require("../email/suppressionService");
const messageDispatcher = require("../email/messageDispatcher");
const queueJobs = require("../../queueJobs/service");
const warmupService = require("../../messaging-core/warmup/senderWarmupService");
const dripService = require("../email/dripService");

const EVENT_TO_STATUS = {
  queued: { status: "queued", field: "queuedAt" },
  sent: { status: "sent", field: "sentAt" },
  failed: { status: "failed", field: null },
  delivered: { status: "delivered", field: "deliveredAt" },
  open: { status: "opened", field: "openedAt" },
  click: { status: "clicked", field: "clickedAt" },
  bounce: { status: "bounced", field: "bouncedAt" },
  complaint: { status: "complained", field: "complainedAt" },
  unsubscribe: { status: "unsubscribed", field: "unsubscribedAt" },
};

function notFound(label) {
  const err = new Error(`${label} not found`);
  err.statusCode = 404;
  return err;
}

function requestContext(req) {
  return {
    ip: req.ip,
    userAgent: req.get?.("user-agent") || null,
    referer: req.get?.("referer") || null,
  };
}

async function recordMarketingEvent(messageId, eventType, payload = {}) {
  const { CrmMarketingMessage, CrmMarketingDeliveryEvent, CrmMarketingCampaign } = getModels();
  const message = await CrmMarketingMessage.findByPk(messageId);
  if (!message) throw notFound("Marketing message");

  const occurredAt = new Date();
  const mapped = EVENT_TO_STATUS[eventType] || null;
  const update = {};
  const isFirstOccurrence = mapped?.field ? !message[mapped.field] : true;
  if (mapped) {
    update.status = mapped.status;
    if (mapped.field && isFirstOccurrence) update[mapped.field] = occurredAt;
  }

  await CrmMarketingDeliveryEvent.create({
    messageId: message.id,
    campaignId: message.campaignId,
    provider: payload.provider || message.provider || "movira",
    providerMessageId: payload.providerMessageId || message.providerMessageId || null,
    eventType,
    payload,
    occurredAt,
  });

  if (Object.keys(update).length) await message.update(update);
  if (isFirstOccurrence) {
    await warmupService.recordMessageResult(message, eventType);
  }

  if (["bounce", "complaint", "unsubscribe"].includes(eventType)) {
    await suppressionService.suppressEmail({
      locationId: message.locationId,
      email: message.recipient,
      reason: suppressionReason(eventType, payload),
      source: payload.source || "tracking_event",
      campaignId: message.campaignId,
      messageId: message.id,
      metadata: {
        eventType,
        provider: payload.provider || message.provider || "movira",
        providerMessageId: payload.providerMessageId || message.providerMessageId || null,
      },
    });
  }

  if (message.campaignId) {
    const metricField = {
      delivered: "totalDelivered",
      open: "totalOpened",
      click: "totalClicked",
      bounce: "totalBounced",
      unsubscribe: "totalUnsubscribed",
      complaint: "totalComplained",
    }[eventType];
    if (metricField && isFirstOccurrence) await CrmMarketingCampaign.increment(metricField, { where: { id: message.campaignId } });
  }

  if (isFirstOccurrence && ["open", "click"].includes(eventType)) {
    try {
      await dripService.wakeEnrollmentForMessage(message);
    } catch (_err) {
      // Tracking remains available if the drip scheduler is temporarily unavailable.
    }
    try {
      await queueJobs.enqueueAutomationEvents([{
        locationId: message.locationId,
        eventType: eventType === "open" ? "email.opened" : "email.clicked",
        email: message.recipient,
        source: "marketing_tracking",
        eventId: `${message.id}:${eventType}`,
        payload: {
          messageId: message.id,
          campaignId: message.campaignId,
          subject: message.subject,
          destinationUrl: payload.destinationUrl || null,
        },
      }], { locationId: message.locationId, source: "marketing_tracking" });
    } catch (_err) {
      // Tracking must not fail if automation has no matching contact/workflow.
    }
  }

  return { messageId: message.id, eventType, occurredAt };
}

function suppressionReason(eventType, payload = {}) {
  if (eventType === "complaint") return "complaint";
  if (eventType === "unsubscribe") return "unsubscribe";
  if (eventType === "bounce") {
    const bounceType = payload.bounce?.bounceType || payload.bounceType || "";
    return String(bounceType).toLowerCase() === "permanent" ? "hard_bounce" : "bounce";
  }
  return eventType;
}

async function recordSesEvent(notification = {}) {
  const { CrmMarketingMessage } = getModels();
  const mail = notification.mail || notification.Mail || {};
  const tags = mail.tags || mail.Tags || {};
  const taggedMessageId = tagValue(tags, "message_id") || tagValue(tags, "messageId");
  const providerMessageId = mail.messageId || mail.MessageId || notification.mailMessageId || null;
  const eventType = normalizeSesEventType(notification.eventType || notification.notificationType || notification.event_type);
  if (!eventType) {
    return { ignored: true, reason: "unsupported_event_type", providerMessageId };
  }

  let message = taggedMessageId ? await CrmMarketingMessage.findByPk(taggedMessageId) : null;
  if (!message && providerMessageId) {
    message = await CrmMarketingMessage.findOne({ where: { providerMessageId } });
  }
  if (!message) {
    return { ignored: true, reason: "message_not_found", providerMessageId, taggedMessageId };
  }

  return recordMarketingEvent(message.id, eventType, {
    source: "ses_webhook",
    provider: "ses",
    providerMessageId,
    sesEventType: notification.eventType || notification.notificationType || notification.event_type,
    bounce: notification.bounce || null,
    complaint: notification.complaint || null,
    delivery: notification.delivery || null,
    open: notification.open || null,
    click: notification.click || null,
  });
}

function tagValue(tags, key) {
  const value = tags?.[key];
  if (Array.isArray(value)) return value[0];
  return value || null;
}

function normalizeSesEventType(value) {
  const key = String(value || "").toLowerCase();
  if (key === "delivery" || key === "delivered") return "delivered";
  if (key === "bounce" || key === "bounced") return "bounce";
  if (key === "complaint" || key === "complained") return "complaint";
  if (key === "open" || key === "opened") return "open";
  if (key === "click" || key === "clicked") return "click";
  if (key === "send" || key === "sent") return "sent";
  if (key === "reject" || key === "rendering failure" || key === "rendering_failure") return "failed";
  return null;
}

async function recordOpen(req, messageId) {
  return recordMarketingEvent(messageId, "open", {
    source: "tracking_pixel",
    ...requestContext(req),
  });
}

async function recordClick(req, messageId, destinationUrl) {
  return recordMarketingEvent(messageId, "click", {
    source: "tracked_redirect",
    destinationUrl,
    ...requestContext(req),
  });
}

async function recordUnsubscribe(req, messageId, { oneClick = false } = {}) {
  return recordMarketingEvent(messageId, "unsubscribe", {
    source: oneClick ? "one_click_unsubscribe" : "unsubscribe_link",
    oneClick,
    ...requestContext(req),
  });
}

async function renderBrowserView(messageId) {
  const { CrmMarketingMessage } = getModels();
  const message = await CrmMarketingMessage.findByPk(messageId);
  if (!message) throw notFound("Marketing message");
  return messageDispatcher.renderStoredMessage(message, { tracking: null });
}

module.exports = {
  recordMarketingEvent,
  recordSesEvent,
  recordOpen,
  recordClick,
  recordUnsubscribe,
  renderBrowserView,
};
