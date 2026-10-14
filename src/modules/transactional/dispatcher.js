const renderer = require("./templateRenderer");
const emailProvider = require("../messaging-core/providers/emailProviderRouter");
const config = require("../../config");
const platformBranding = require("../../shared/platformBranding");
const { isMoviraControlMessage } = require("../../shared/communicationScope");

function trackingUrls(messageId) {
  const base = config.urls.trackingBaseUrl || config.urls.publicBaseUrl;
  if (!base) return null;
  return {
    openPixelUrl: `${base}/t/open/${messageId}.gif`,
    clickBaseUrl: `${base}/t/click/${messageId}`,
  };
}

async function dispatch(message) {
  if (message.channel !== "email") {
    throw new Error(`Transactional channel not implemented yet: ${message.channel}`);
  }

  const freshBranding = Boolean(message.payload?.__test);
  const branding = isMoviraControlMessage(message)
    ? await platformBranding.getPlatformBranding({ fresh: freshBranding })
    : await platformBranding.getEmailBranding(message.locationId, { fresh: freshBranding });
  // Sequelize model attributes are exposed through getters and are not copied by
  // object spread. Convert the instance first; otherwise fields such as
  // locationId disappear before template resolution.
  const messageData = typeof message?.get === "function"
    ? message.get({ plain: true })
    : message;
  const brandedMessage = {
    ...messageData,
    payload: {
      ...(messageData?.payload || {}),
      ...branding,
    },
  };
  const rendered = await renderer.renderTransactionalMessage(brandedMessage, {
    tracking: trackingUrls(message.id),
  });
  const attachments = (message.attachments || []).map((a) => ({
    filename: a.filename || "attachment",
    content: a.encoding === "base64" && typeof a.content === "string"
      ? Buffer.from(a.content, "base64")
      : a.content,
    contentType: a.contentType || undefined,
  }));
  const testOverrides = brandedMessage.payload?.__test || {};
  return emailProvider.sendTransactionalEmail({
    locationId: message.locationId,
    to: message.recipientAddress,
    subject: testOverrides.requestedSubject || rendered.subject,
    html: rendered.body,
    text: rendered.text || rendered.template.config?.textFallback,
    from: testOverrides.requestedFrom || rendered.template.config?.from,
    attachments,
    messageId: message.id,
    sourceEventType: message.sourceEventType,
    sourceSystem: message.sourceSystem,
    communicationScope: isMoviraControlMessage(message) ? "movira_control" : "location",
  });
}

module.exports = {
  dispatch,
};
