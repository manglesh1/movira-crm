const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");
const MailComposer = require("nodemailer/lib/mail-composer");
const { Op } = require("sequelize");
const { getModels } = require("../../../db/models");
const config = require("../../../config");
const moviraSesProvider = require("./sesEmailProvider");
const domainSenderResolver = require("./domainSenderResolver");
const replyForwardService = require("../../settings/email/replyForwardService");
const { decryptJsonIfNeeded } = require("../../../shared/credentialVault");

function providerUseCase(kind) {
  return kind === "transactional" ? "transactional" : "marketing";
}

async function findProvider({ locationId, useCase }) {
  const { CrmProviderConfig } = getModels();
  if (!locationId) return null;
  const rows = await CrmProviderConfig.findAll({
    where: {
      locationId: Number(locationId),
      channel: "email",
      isActive: true,
      domain: { [Op.in]: [useCase, "both"] },
    },
    order: [["priority", "ASC"], ["createdAt", "ASC"]],
    limit: 1,
  });
  return rows[0] || null;
}

async function sendTransactionalEmail(input = {}) {
  return sendEmail({ ...input, useCase: "transactional" });
}

async function sendMarketingEmail(input = {}) {
  return sendEmail({ ...input, useCase: "marketing" });
}

async function sendEmail(input = {}) {
  const useCase = providerUseCase(input.useCase);
  const [sender, deliverySettings] = await Promise.all([
    useCase === "marketing" ? domainSenderResolver.requireMarketingSender({ locationId: input.locationId, from: input.from }) : domainSenderResolver.resolveSender({
      locationId: input.locationId,
      useCase,
      requestedFrom: input.from,
    }),
    replyForwardService.getOutboundDeliverySettings({ locationId: input.locationId }),
  ]);
  const resolvedInput = {
    ...input,
    ...(sender ? { from: sender.from } : {}),
    replyTo: input.replyTo || deliverySettings.replyTo || undefined,
    bcc: normalizeAddresses(input.bcc?.length ? input.bcc : deliverySettings.bcc),
  };
  const providerRow = sender
    ? (sender.providerConfigId ? await findProviderById(sender.providerConfigId) : null)
    : await findProvider({ locationId: input.locationId, useCase });
  if (sender?.providerConfigId && !providerRow) {
    const err = new Error("The selected sender email provider is inactive or unavailable.");
    err.statusCode = 409;
    err.code = "SENDER_PROVIDER_UNAVAILABLE";
    throw err;
  }
  if (!providerRow || providerRow.provider === "movira_ses") {
    const result = useCase === "transactional"
      ? moviraSesProvider.sendTransactionalEmail(resolvedInput)
      : moviraSesProvider.sendMarketingEmail(resolvedInput);
    return enrichResult(await result, providerRow, sender);
  }
  return enrichResult(await sendWithProviderRow(providerRow, resolvedInput, useCase), providerRow, sender);
}

async function findProviderById(id) {
  const { CrmProviderConfig } = getModels();
  if (!id) return null;
  return CrmProviderConfig.findOne({
    where: {
      id,
      channel: "email",
      isActive: true,
    },
  });
}

async function sendWithProviderRow(providerRow, input = {}, useCase = providerUseCase(providerRow?.domain)) {
  const cfg = decryptJsonIfNeeded(providerRow.encryptedConfig);
  if (providerRow.provider === "customer_ses") {
    return sendCustomerSes(providerRow, cfg, input, useCase);
  }
  if (providerRow.provider === "customer_sendgrid") {
    return sendSendgrid(providerRow, cfg, input, useCase);
  }
  if (providerRow.provider === "customer_mailgun") {
    return sendMailgun(providerRow, cfg, input, useCase);
  }
  if (providerRow.provider === "customer_postmark") {
    return sendPostmark(providerRow, cfg, input, useCase);
  }

  return useCase === "transactional"
    ? moviraSesProvider.sendTransactionalEmail(input)
    : moviraSesProvider.sendMarketingEmail(input);
}

function enrichResult(result = {}, providerRow, sender) {
  return {
    ...result,
    providerConfigId: result.providerConfigId || providerRow?.id || sender?.providerConfigId || null,
    senderDomainId: sender?.domainId || null,
    senderDomain: sender?.domain || null,
  };
}

async function sendCustomerSes(providerRow, cfg, input, useCase) {
  const client = new SESv2Client({
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });
  const tags = [
    { Name: "domain", Value: useCase },
    ...(input.messageId ? [{ Name: "message_id", Value: String(input.messageId).slice(0, 256) }] : []),
    ...(input.trackingTags || []).map((tag) => ({
      Name: String(tag.name).slice(0, 256),
      Value: String(tag.value).slice(0, 256),
    })),
  ];
  const fromAddress = input.from || cfg.fromEmail || config.aws.ses.defaultFrom;
  const base = {
    FromEmailAddress: fromAddress,
    ConfigurationSetName: input.configurationSet || cfg.configurationSet || undefined,
    Destination: destinationFor(input.to, input.bcc),
    ...replyToFor(input.replyTo),
    EmailTags: tags,
  };
  const content = (input.attachments?.length || Object.keys(normalizeHeaders(input.headers)).length)
    ? { Raw: { Data: await buildRawMime({ ...input, from: fromAddress }) } }
    : {
        Simple: {
          Subject: { Data: input.subject || "", Charset: "UTF-8" },
          Body: {
            Html: { Data: input.html || input.text || "", Charset: "UTF-8" },
            Text: { Data: input.text || stripHtml(input.html || ""), Charset: "UTF-8" },
          },
        },
      };
  const result = await client.send(new SendEmailCommand({ ...base, Content: content }));
  return {
    provider: providerRow.provider,
    providerConfigId: providerRow.id,
    providerMessageId: result.MessageId || null,
  };
}

async function sendSendgrid(providerRow, cfg, input, useCase = providerUseCase(providerRow?.domain)) {
  if (typeof fetch !== "function") {
    throw new Error("SendGrid provider requires Node 18+ fetch support.");
  }
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{
        to: [{ email: input.to }],
        ...(Object.keys(normalizeHeaders(input.headers)).length ? { headers: normalizeHeaders(input.headers) } : {}),
        ...(normalizeAddresses(input.bcc).length
          ? { bcc: normalizeAddresses(input.bcc).map((email) => ({ email })) }
          : {}),
      }],
      from: sendgridFrom(input.from || cfg.fromEmail || config.aws.ses.defaultFrom),
      ...(input.replyTo ? { reply_to: { email: input.replyTo } } : {}),
      subject: input.subject || "",
      custom_args: {
        domain: useCase,
        ...(input.messageId ? { message_id: String(input.messageId) } : {}),
        ...(input.trackingTags || []).reduce((acc, tag) => {
          acc[String(tag.name).slice(0, 120)] = String(tag.value).slice(0, 500);
          return acc;
        }, {}),
      },
      content: [
        { type: "text/plain", value: input.text || stripHtml(input.html || "") },
        { type: "text/html", value: input.html || input.text || "" },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SendGrid send failed: ${res.status} ${res.statusText}${text ? ` ${text}` : ""}`);
  }
  return {
    provider: providerRow.provider,
    providerConfigId: providerRow.id,
    providerMessageId: res.headers.get("x-message-id") || null,
  };
}

async function sendMailgun(providerRow, cfg, input, useCase) {
  if (typeof fetch !== "function" || typeof FormData !== "function") {
    throw new Error("Mailgun provider requires Node 18+ fetch/FormData support.");
  }
  const form = new FormData();
  form.append("from", input.from || cfg.fromEmail || config.aws.ses.defaultFrom);
  form.append("to", input.to);
  form.append("subject", input.subject || "");
  form.append("html", input.html || input.text || "");
  form.append("text", input.text || stripHtml(input.html || ""));
  if (input.replyTo) form.append("h:Reply-To", input.replyTo);
  for (const [name, value] of Object.entries(normalizeHeaders(input.headers))) form.append(`h:${name}`, value);
  for (const email of normalizeAddresses(input.bcc)) form.append("bcc", email);
  form.append("v:domain", useCase);
  if (input.messageId) form.append("v:message_id", String(input.messageId));
  for (const tag of input.trackingTags || []) {
    form.append(`v:${String(tag.name).slice(0, 120)}`, String(tag.value).slice(0, 500));
  }
  for (const attachment of input.attachments || []) {
    const content = Buffer.isBuffer(attachment.content)
      ? attachment.content
      : Buffer.from(String(attachment.content || ""), attachment.encoding === "base64" ? "base64" : "utf8");
    form.append(
      "attachment",
      new Blob([content], { type: attachment.contentType || "application/octet-stream" }),
      attachment.filename || "attachment"
    );
  }

  const res = await fetch(`${mailgunApiBase(cfg.region)}/v3/${encodeURIComponent(cfg.domain)}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`api:${cfg.apiKey}`).toString("base64")}`,
    },
    body: form,
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Mailgun send failed: ${res.status} ${res.statusText}${text ? ` ${text}` : ""}`);
  }
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (_err) {
    parsed = {};
  }
  return {
    provider: providerRow.provider,
    providerConfigId: providerRow.id,
    providerMessageId: parsed.id || null,
  };
}

async function sendPostmark(providerRow, cfg, input, useCase) {
  if (typeof fetch !== "function") {
    throw new Error("Postmark provider requires Node 18+ fetch support.");
  }
  const body = {
    From: input.from || cfg.fromEmail || config.aws.ses.defaultFrom,
    To: input.to,
    Subject: input.subject || "",
    HtmlBody: input.html || input.text || "",
    TextBody: input.text || stripHtml(input.html || ""),
    ReplyTo: input.replyTo || undefined,
    Bcc: normalizeAddresses(input.bcc).join(",") || undefined,
    Metadata: {
      domain: useCase,
      ...(input.messageId ? { message_id: String(input.messageId) } : {}),
      ...(input.trackingTags || []).reduce((acc, tag) => {
        acc[String(tag.name).slice(0, 120)] = String(tag.value).slice(0, 500);
        return acc;
      }, {}),
    },
    Headers: Object.entries(normalizeHeaders(input.headers)).map(([Name, Value]) => ({ Name, Value })),
  };
  if (cfg.messageStream) body.MessageStream = cfg.messageStream;
  if (input.attachments?.length) {
    body.Attachments = input.attachments.map((attachment) => {
      const content = Buffer.isBuffer(attachment.content)
        ? attachment.content
        : Buffer.from(String(attachment.content || ""), attachment.encoding === "base64" ? "base64" : "utf8");
      return {
        Name: attachment.filename || "attachment",
        Content: content.toString("base64"),
        ContentType: attachment.contentType || "application/octet-stream",
      };
    });
  }
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": cfg.serverToken,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Postmark send failed: ${res.status} ${res.statusText}${text ? ` ${text}` : ""}`);
  }
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (_err) {
    parsed = {};
  }
  return {
    provider: providerRow.provider,
    providerConfigId: providerRow.id,
    providerMessageId: parsed.MessageID || parsed.MessageId || null,
  };
}

function mailgunApiBase(region) {
  return String(region || "us").toLowerCase() === "eu"
    ? "https://api.eu.mailgun.net"
    : "https://api.mailgun.net";
}

function buildRawMime({ from, to, subject, html, text, attachments, replyTo, bcc, headers }) {
  return new Promise((resolve, reject) => {
    const composer = new MailComposer({
      from,
      to,
      replyTo: replyTo || undefined,
      bcc: normalizeAddresses(bcc),
      subject: subject || "",
      headers: normalizeHeaders(headers),
      html: html || "",
      text: text || stripHtml(html || ""),
      attachments: (attachments || []).map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType || undefined,
        encoding: a.encoding || undefined,
      })),
    });
    composer.compile().build((err, message) => {
      if (err) return reject(err);
      resolve(message);
    });
  });
}

function normalizeHeaders(headers) {
  return Object.fromEntries(Object.entries(headers || {}).filter(([name, value]) =>
    /^[A-Za-z0-9-]+$/.test(name) && value !== undefined && value !== null && !/[\r\n]/.test(String(value))
  ).map(([name, value]) => [name, String(value)]));
}

function normalizeAddresses(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return Array.from(new Set(values.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)));
}

function destinationFor(to, bcc) {
  const bccAddresses = normalizeAddresses(bcc);
  return {
    ToAddresses: [to],
    ...(bccAddresses.length ? { BccAddresses: bccAddresses } : {}),
  };
}

function replyToFor(replyTo) {
  const addresses = normalizeAddresses(replyTo);
  return addresses.length ? { ReplyToAddresses: addresses } : {};
}

function sendgridFrom(value) {
  const text = String(value || "").trim();
  const matched = text.match(/^\s*"?([^"<]*)"?\s*<([^<>]+)>\s*$/);
  return matched
    ? { email: matched[2].trim(), ...(matched[1].trim() ? { name: matched[1].trim() } : {}) }
    : { email: text };
}

function stripHtml(html) {
  return String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

module.exports = {
  sendTransactionalEmail,
  sendMarketingEmail,
  sendWithProviderRow,
};
