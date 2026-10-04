const config = require("../../../config");
const { getModels } = require("../../../db/models");
const emailProvider = require("../../messaging-core/providers/emailProviderRouter");
const { renderDesign, interpolate } = require("./builder/renderer");
const { createDefaultDesign } = require("./builder/defaultDesign");
const { renderRawTemplate } = require("./rawTemplateRenderer");

function trackingUrls(messageId) {
  const base = config.urls.trackingBaseUrl;
  if (!base) return null;
  return {
    openPixelUrl: `${base}/m/open/${messageId}.gif`,
    clickBaseUrl: `${base}/m/click/${messageId}`,
  };
}

function publicMessageUrls(messageId) {
  const base = config.urls.trackingBaseUrl || config.urls.publicBaseUrl;
  if (!base) return {};
  return {
    unsubscribeUrl: `${base}/m/unsubscribe/${messageId}`,
    viewInBrowserUrl: `${base}/m/view/${messageId}`,
  };
}

function oneClickUnsubscribeHeaders(messageId) {
  const { unsubscribeUrl } = publicMessageUrls(messageId);
  if (!unsubscribeUrl) return {};
  return {
    "List-Unsubscribe": `<${unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

async function dispatch(message) {
  if (message.channel !== "email") {
    throw new Error(`Marketing channel not implemented yet: ${message.channel}`);
  }

  const { CrmMarketingTemplate } = getModels();
  const template = message.templateId ? await CrmMarketingTemplate.findByPk(message.templateId) : null;
  if (!template) {
    throw new Error(`Marketing template not found for message ${message.id}`);
  }
  if (template.useCase === "transactional") {
    throw new Error("Transactional templates cannot be sent through marketing queues");
  }

  const payload = message.payload || {};
  const from = payload.from || undefined;
  const rendered = renderMessageTemplate(message, template, { tracking: trackingUrls(message.id) });

  return emailProvider.sendMarketingEmail({
    locationId: message.locationId,
    to: message.recipient,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    from,
    headers: oneClickUnsubscribeHeaders(message.id),
    trackingTags: [
      { name: "domain", value: "marketing" },
      { name: "message_id", value: message.id },
      ...(message.campaignId ? [{ name: "campaign_id", value: message.campaignId }] : []),
      ...(message.templateId ? [{ name: "template_id", value: message.templateId }] : []),
    ],
  });
}

async function renderStoredMessage(message, { tracking = null } = {}) {
  const { CrmMarketingTemplate } = getModels();
  const template = message.templateId ? await CrmMarketingTemplate.findByPk(message.templateId) : null;
  if (!template) {
    throw new Error(`Marketing template not found for message ${message.id}`);
  }
  return renderMessageTemplate(message, template, { tracking });
}

function renderMessageTemplate(message, template, { tracking = null } = {}) {
  const payload = message.payload || {};
  const data = {
    ...(payload.data || payload.mergeData || {}),
    ...publicMessageUrls(message.id),
  };
  const subject = interpolate(message.subject || payload.subject || template.name, data);

  if (template.editorType === "design") {
    const rendered = renderDesign(template.designJson || createDefaultDesign(), {
      title: template.name,
      data,
      tracking,
    });
    return { subject, html: rendered.html, text: "" };
  }

  const rendered = renderRawTemplate({ editorType: template.editorType, htmlBody: template.htmlBody, plainText: template.plainText, data, tracking });
  return { subject, html: rendered.htmlBody, text: rendered.plainText };
}

module.exports = {
  dispatch,
  renderStoredMessage,
  publicMessageUrls,
  oneClickUnsubscribeHeaders,
};
