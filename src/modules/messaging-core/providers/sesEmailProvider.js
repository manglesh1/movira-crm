const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");
const MailComposer = require("nodemailer/lib/mail-composer");
const config = require("../../../config");

let client = null;

function getClient() {
  if (!client) {
    client = new SESv2Client({ region: config.aws.ses.region || config.aws.region });
  }
  return client;
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

async function sendTransactionalEmail({ to, subject, html, text, from, attachments = [], messageId, replyTo, bcc = [], headers = {} }) {
  const fromAddress = from || config.aws.ses.defaultFrom;
  const tags = [{ Name: "domain", Value: "transactional" }];
  if (messageId) tags.push({ Name: "message_id", Value: String(messageId).slice(0, 256) });

  if ((attachments && attachments.length > 0) || Object.keys(normalizeHeaders(headers)).length) {
    const rawMessage = await buildRawMime({
      from: fromAddress,
      to,
      subject,
      html,
      text,
      attachments,
      replyTo,
      bcc,
      headers,
    });
    const command = new SendEmailCommand({
      FromEmailAddress: fromAddress,
      ConfigurationSetName: config.aws.ses.transactionalConfigSet,
      Destination: destinationFor(to, bcc),
      ...replyToFor(replyTo),
      EmailTags: tags,
      Content: { Raw: { Data: rawMessage } },
    });
    const result = await getClient().send(command);
    return { provider: "ses", providerMessageId: result.MessageId };
  }

  const command = new SendEmailCommand({
    FromEmailAddress: fromAddress,
    ConfigurationSetName: config.aws.ses.transactionalConfigSet,
    Destination: destinationFor(to, bcc),
    ...replyToFor(replyTo),
    EmailTags: tags,
    Content: {
      Simple: {
        Subject: {
          Data: subject || "",
          Charset: "UTF-8",
        },
        Body: {
          Html: {
            Data: html || text || "",
            Charset: "UTF-8",
          },
          Text: {
            Data: text || stripHtml(html || ""),
            Charset: "UTF-8",
          },
        },
      },
    },
  });

  const result = await getClient().send(command);
  return {
    provider: "ses",
    providerMessageId: result.MessageId,
  };
}

async function sendMarketingEmail({ to, subject, html, text, from, trackingTags = [], replyTo, bcc = [], headers = {} }) {
  const fromAddress = from || config.aws.ses.defaultFrom;
  const emailTags = trackingTags.map((tag) => ({
    Name: String(tag.name).slice(0, 256),
    Value: String(tag.value).slice(0, 256),
  }));
  if (Object.keys(normalizeHeaders(headers)).length) {
    const rawMessage = await buildRawMime({ from: fromAddress, to, subject, html, text, replyTo, bcc, headers });
    const result = await getClient().send(new SendEmailCommand({
      FromEmailAddress: fromAddress,
      ConfigurationSetName: config.aws.ses.marketingConfigSet,
      Destination: destinationFor(to, bcc),
      ...replyToFor(replyTo),
      EmailTags: emailTags,
      Content: { Raw: { Data: rawMessage } },
    }));
    return { provider: "ses", providerMessageId: result.MessageId };
  }
  const command = new SendEmailCommand({
    FromEmailAddress: fromAddress,
    ConfigurationSetName: config.aws.ses.marketingConfigSet,
    Destination: destinationFor(to, bcc),
    ...replyToFor(replyTo),
    EmailTags: emailTags,
    Content: {
      Simple: {
        Subject: {
          Data: subject || "",
          Charset: "UTF-8",
        },
        Body: {
          Html: {
            Data: html || text || "",
            Charset: "UTF-8",
          },
          Text: {
            Data: text || stripHtml(html || ""),
            Charset: "UTF-8",
          },
        },
      },
    },
  });

  const result = await getClient().send(command);
  return {
    provider: "ses",
    providerMessageId: result.MessageId,
  };
}

function normalizeHeaders(headers) {
  return Object.fromEntries(Object.entries(headers || {}).filter(([name, value]) =>
    /^[A-Za-z0-9-]+$/.test(name) && value !== undefined && value !== null && !/[\r\n]/.test(String(value))
  ).map(([name, value]) => [name, String(value)]));
}

function stripHtml(html) {
  return String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
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

module.exports = {
  sendTransactionalEmail,
  sendMarketingEmail,
};
