const repository = require("./repository");
const { renderDesign, applyTracking } = require("../marketing/email/builder/renderer");
const { createDefaultDesign } = require("../marketing/email/builder/defaultDesign");

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

function getByPath(obj, path) {
  return String(path)
    .split(".")
    .reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
}

function interpolate(input, payload) {
  if (!input) return "";
  return String(input).replace(TOKEN_RE, (_match, key) => {
    const value = getByPath(payload, key);
    return value == null ? "" : String(value);
  });
}

function normalizePayload(payload = {}) {
  const contact = payload.contact || {};
  const business = payload.business || {};
  const booking = payload.booking || {};
  const payment = payload.payment || {};
  const waiver = payload.waiver || {};
  const guestName =
    payload.guestName ||
    payload.customerName ||
    contact.fullName ||
    payload.name ||
    "Customer";
  const venueName =
    payload.locationName ||
    payload.venueName ||
    business.name ||
    "Movira";

  return {
    ...payload,
    guestName,
    guestFirstName:
      payload.guestFirstName ||
      contact.firstName ||
      String(guestName).trim().split(/\s+/)[0] ||
      "Customer",
    venueName,
    locationName: payload.locationName || venueName,
    locationAddress: payload.locationAddress || business.address || "",
    locationPhone: payload.locationPhone || business.phone || "",
    locationEmail: payload.locationEmail || business.email || "",
    supportEmail: payload.supportEmail || payload.locationEmail || business.email || "",
    supportPhone: payload.supportPhone || payload.locationPhone || business.phone || "",
    supportUrl: payload.supportUrl || "",
    emailBrandName: payload.emailBrandName || "Movira360",
    emailBrandTagline:
      payload.emailBrandTagline ||
      (payload.templateScope === "movira_control"
        ? "Secure Movira Control communication"
        : "Secure location communication"),
    bookingNumber: payload.bookingNumber || booking.number || "",
    bookingName: payload.bookingName || booking.name || "",
    bookingDate: payload.bookingDate || booking.date || "",
    totalAmount: payload.totalAmount || booking.total || "",
    amountPaid: payload.amountPaid || payment.amount || "",
    amountDue: payload.amountDue || payment.amountDue || payment.balance || "",
    gateway: payload.gateway || payment.gateway || "",
    paymentLink: payload.paymentLink || payment.link || "",
    receiptUrl: payload.receiptUrl || booking.receiptUrl || "",
    ticketsUrl: payload.ticketsUrl || booking.ticketsUrl || "",
    qrCodeUrl: payload.qrCodeUrl || booking.qrCodeUrl || "",
    waiverShareUrl:
      payload.waiverShareUrl || payload.waiverLink || waiver.shareUrl || "",
    moviraLogoUrl:
      payload.moviraLogoUrl ||
      process.env.MOVIRA360_EMAIL_LOGO_URL ||
      "https://app.movira360.com/branding/movira360-logo.png",
    movira360Url:
      payload.movira360Url ||
      process.env.MOVIRA360_PUBLIC_URL ||
      "https://www.movira360.com",
  };
}

function renderTemplate(template, payload, { tracking = null } = {}) {
  const normalizedPayload = normalizePayload(payload);
  const subject = interpolate(template.subject, normalizedPayload);

  if (template.editorType === "design") {
    const rendered = renderDesign(template.designJson || createDefaultDesign(), {
      title: template.name,
      data: normalizedPayload,
      tracking,
    });
    return {
      subject,
      body: rendered.html,
      text: interpolate(template.plainText, normalizedPayload),
      template,
    };
  }

  return {
    subject,
    body: applyTracking(interpolate(template.body, normalizedPayload), tracking),
    text: interpolate(template.plainText, normalizedPayload),
    template,
  };
}

async function renderTransactionalMessage(message, options = {}) {
  const template = await repository.findTemplate({
    locationId: message.locationId,
    key: message.templateKey,
    channel: message.channel,
  });

  if (!template) {
    throw new Error(
      `Transactional template not found: ${message.templateKey}/${message.channel}`
    );
  }

  return renderTemplate(template, message.payload, options);
}

module.exports = {
  renderTransactionalMessage,
  renderTemplate,
  interpolate,
  normalizePayload,
};
