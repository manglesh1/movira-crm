const crypto = require("crypto");
const config = require("../config");

function unauthorized(res, message = "Webhook signature verification failed.") {
  return res.status(401).json({ success: false, error: "invalid_webhook_signature", message });
}

function missingConfig(res, provider) {
  if (config.security.allowUnsignedWebhooks) return null;
  return res.status(500).json({
    success: false,
    error: "webhook_signature_not_configured",
    message: `${provider} webhook verification is not configured.`,
  });
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function rawBody(req) {
  return Buffer.isBuffer(req.rawBody)
    ? req.rawBody
    : Buffer.from(JSON.stringify(req.body || {}));
}

function verifySharedSecret(req) {
  if (!config.webhooks.sharedSecret) return false;
  return timingSafeEqual(req.headers["x-movira-webhook-secret"], config.webhooks.sharedSecret);
}

function wrapPublicKey(value) {
  const key = String(value || "").trim();
  if (!key || key.includes("BEGIN PUBLIC KEY")) return key;
  return `-----BEGIN PUBLIC KEY-----\n${key.match(/.{1,64}/g)?.join("\n") || key}\n-----END PUBLIC KEY-----`;
}

function canonicalSnsMessage(message = {}) {
  const type = message.Type;
  const fieldsByType = {
    Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
    SubscriptionConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
    UnsubscribeConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
  };
  const fields = fieldsByType[type] || fieldsByType.Notification;
  return fields
    .filter((field) => message[field] !== undefined && message[field] !== null)
    .map((field) => `${field}\n${message[field]}\n`)
    .join("");
}

function isTrustedSnsCertUrl(urlValue) {
  try {
    const url = new URL(urlValue);
    return (
      url.protocol === "https:" &&
      /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname) &&
      url.pathname.endsWith(".pem")
    );
  } catch {
    return false;
  }
}

async function verifySesSns(req) {
  if (verifySharedSecret(req)) return true;
  const body = req.body || {};
  if (!body.Signature || !body.SigningCertURL || !body.SignatureVersion) return false;
  if (!isTrustedSnsCertUrl(body.SigningCertURL)) return false;

  const response = await fetch(body.SigningCertURL);
  if (!response.ok) return false;
  const cert = await response.text();
  const algorithm = body.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
  const verifier = crypto.createVerify(algorithm);
  verifier.update(canonicalSnsMessage(body), "utf8");
  return verifier.verify(cert, body.Signature, "base64");
}

function verifyMailgun(req) {
  if (verifySharedSecret(req)) return true;
  const key = config.webhooks.mailgunSigningKey;
  if (!key) return false;
  const signature = req.body?.signature || req.body?.Signature || {};
  const timestamp = signature.timestamp || req.body?.timestamp;
  const token = signature.token || req.body?.token;
  const expectedSignature = signature.signature || req.body?.signature;
  if (!timestamp || !token || !expectedSignature) return false;
  const digest = crypto.createHmac("sha256", key).update(`${timestamp}${token}`).digest("hex");
  return timingSafeEqual(digest, expectedSignature);
}

function verifySendgrid(req) {
  if (verifySharedSecret(req)) return true;
  const publicKey = wrapPublicKey(config.webhooks.sendgridPublicKey);
  if (!publicKey) return false;
  const signature = req.headers["x-twilio-email-event-webhook-signature"];
  const timestamp = req.headers["x-twilio-email-event-webhook-timestamp"];
  if (!signature || !timestamp) return false;
  const verifier = crypto.createVerify("sha256");
  verifier.update(Buffer.concat([Buffer.from(String(timestamp)), rawBody(req)]));
  verifier.end();
  return verifier.verify(publicKey, signature, "base64");
}

function verifyPostmark(req) {
  if (verifySharedSecret(req)) return true;
  const token = config.webhooks.postmarkToken;
  if (token && timingSafeEqual(req.headers["x-postmark-webhook-token"], token)) return true;

  const username = config.webhooks.postmarkUsername;
  const password = config.webhooks.postmarkPassword;
  if (!username || !password) return false;
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  return timingSafeEqual(decoded, `${username}:${password}`);
}

function verifyMovira(req) {
  return verifySharedSecret(req);
}

function verifyMeta(req) {
  const secret = config.integrations.meta.appSecret;
  const signature = String(req.headers["x-hub-signature-256"] || "");
  if (!secret || !signature.startsWith("sha256=")) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody(req)).digest("hex")}`;
  return timingSafeEqual(signature, expected);
}

function webhookAuth(provider) {
  return async function webhookAuthMiddleware(req, res, next) {
    try {
      if (config.security.allowUnsignedWebhooks && !config.webhooks.sharedSecret) {
        const hasProviderConfig =
          (provider === "ses" && req.body?.Signature) ||
          (provider === "mailgun" && config.webhooks.mailgunSigningKey) ||
          (provider === "sendgrid" && config.webhooks.sendgridPublicKey) ||
          (provider === "postmark" && (config.webhooks.postmarkToken || config.webhooks.postmarkUsername)) ||
          (provider === "meta" && config.integrations.meta.appSecret);
        if (!hasProviderConfig) return next();
      }

      const verifierByProvider = {
        ses: verifySesSns,
        mailgun: verifyMailgun,
        sendgrid: verifySendgrid,
        postmark: verifyPostmark,
        movira: verifyMovira,
        meta: verifyMeta,
      };
      const verifier = verifierByProvider[provider];
      if (!verifier) return unauthorized(res);
      const configured =
        config.webhooks.sharedSecret ||
        (provider === "ses") ||
        (provider === "mailgun" && config.webhooks.mailgunSigningKey) ||
        (provider === "sendgrid" && config.webhooks.sendgridPublicKey) ||
        (provider === "postmark" && (config.webhooks.postmarkToken || config.webhooks.postmarkUsername)) ||
        (provider === "movira" && config.webhooks.sharedSecret) ||
        (provider === "meta" && config.integrations.meta.appSecret);
      if (!configured) {
        const response = missingConfig(res, provider);
        if (response) return response;
      }

      const ok = await verifier(req);
      if (!ok) return unauthorized(res);
      return next();
    } catch (err) {
      req.log?.warn?.({ err, provider }, "Webhook signature verification failed");
      return unauthorized(res);
    }
  };
}

module.exports = { webhookAuth, _internal: { verifyMeta, timingSafeEqual, rawBody } };
