const {
  SESv2Client,
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
} = require("@aws-sdk/client-sesv2");
const { decryptJsonIfNeeded } = require("../../../shared/credentialVault");
const config = require("../../../config");
const moviraSesIdentity = require("./sesIdentityService");

async function createDomainIdentity({ provider, providerConfig, domain }) {
  if (provider === "movira_ses") return moviraSesIdentity.createIdentity(domain);
  if (provider === "customer_ses") return createCustomerSesIdentity(providerConfig, domain);
  if (provider === "customer_sendgrid") return createSendGridDomain(providerConfig, domain);
  if (provider === "customer_mailgun") return getMailgunDomain(providerConfig, domain);
  if (provider === "customer_postmark") return createPostmarkDomain(providerConfig, domain);
  throw httpError(400, `Unsupported email provider for dedicated domains: ${provider}`);
}

async function refreshDomainIdentity({ provider, providerConfig, domain, identityName }) {
  if (provider === "movira_ses") return refreshMoviraSes(domain, identityName);
  if (provider === "customer_ses") return refreshCustomerSes(providerConfig, domain, identityName);
  if (provider === "customer_sendgrid") return refreshSendGridDomain(providerConfig, identityName);
  if (provider === "customer_mailgun") return getMailgunDomain(providerConfig, domain);
  if (provider === "customer_postmark") return refreshPostmarkDomain(providerConfig, identityName || domain);
  throw httpError(400, `Unsupported email provider for dedicated domains: ${provider}`);
}

async function deleteDomainIdentity({ provider, providerConfig, domain, identityName }) {
  if (provider === "movira_ses") return moviraSesIdentity.deleteIdentity(identityName || domain);
  if (provider === "customer_ses") return deleteCustomerSesIdentity(providerConfig, identityName || domain);
  return false;
}

async function refreshMoviraSes(domain, identityName) {
  const identity = await moviraSesIdentity.getIdentity(identityName || domain);
  return {
    providerIdentityName: identity.providerIdentityName,
    providerIdentityArn: identity.providerIdentityArn,
    mailFromDomain: identity.mailFromDomain,
    dnsRecords: moviraSesIdentity.buildRecordsFromIdentity(domain, identity),
    providerVerified: Boolean(identity.verifiedForSendingStatus),
  };
}

async function createCustomerSesIdentity(providerConfig, domain) {
  const client = customerSesClient(providerConfig);
  const existing = await getCustomerSesIdentityIfExists(client, domain);
  const created = existing
    ? { IdentityArn: existing.providerIdentityArn }
    : await client.send(
        new CreateEmailIdentityCommand({
          EmailIdentity: domain,
        })
      );
  await putCustomerMailFrom(client, domain);
  const identity = await getCustomerSesIdentity(client, domain);
  return {
    providerIdentityName: domain,
    providerIdentityArn: created.IdentityArn || identity.providerIdentityArn || null,
    mailFromDomain: identity.mailFromDomain,
    dnsRecords: buildSesRecords(domain, identity),
    providerVerified: Boolean(identity.verifiedForSendingStatus),
  };
}

async function getCustomerSesIdentityIfExists(client, domain) {
  try {
    return await getCustomerSesIdentity(client, domain);
  } catch (err) {
    if (err?.name === "NotFoundException" || err?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

async function refreshCustomerSes(providerConfig, domain, identityName) {
  const client = customerSesClient(providerConfig);
  const identity = await getCustomerSesIdentity(client, identityName || domain);
  return {
    providerIdentityName: identityName || domain,
    providerIdentityArn: identity.providerIdentityArn,
    mailFromDomain: identity.mailFromDomain,
    dnsRecords: buildSesRecords(domain, identity),
    providerVerified: Boolean(identity.verifiedForSendingStatus),
  };
}

function customerSesClient(providerConfig) {
  const cfg = decryptJsonIfNeeded(providerConfig?.encryptedConfig);
  if (!cfg.region || !cfg.accessKeyId || !cfg.secretAccessKey) {
    throw httpError(400, "Customer SES provider is missing region, access key, or secret key.");
  }
  validateAwsRegion(cfg.region, "Customer SES region");
  return new SESv2Client({
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });
}

function validateAwsRegion(region, label = "AWS region") {
  const value = String(region || "").trim();
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(value)) {
    throw httpError(400, `${label} must be a valid AWS region like us-east-1 or ca-central-1.`);
  }
  return value;
}

async function putCustomerMailFrom(client, domain) {
  await client.send(
    new PutEmailIdentityMailFromAttributesCommand({
      EmailIdentity: domain,
      MailFromDomain: moviraSesIdentity.mailFromDomain(domain),
      BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
    })
  );
}

async function getCustomerSesIdentity(client, domain) {
  const result = await client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
  const dkim = result.DkimAttributes || {};
  const mailFrom = result.MailFromAttributes || {};
  return {
    providerIdentityArn: result.IdentityArn || null,
    verifiedForSendingStatus: Boolean(result.VerifiedForSendingStatus),
    dkimTokens: Array.isArray(dkim.Tokens) ? dkim.Tokens : [],
    mailFromDomain: mailFrom.MailFromDomain || moviraSesIdentity.mailFromDomain(domain),
  };
}

function buildSesRecords(domain, identity) {
  return moviraSesIdentity.buildRecordsFromIdentity(domain, {
    dkimTokens: identity.dkimTokens,
    mailFromDomain: identity.mailFromDomain,
  });
}

async function deleteCustomerSesIdentity(providerConfig, domain) {
  const client = customerSesClient(providerConfig);
  try {
    await client.send(new DeleteEmailIdentityCommand({ EmailIdentity: domain }));
    return true;
  } catch (err) {
    if (err?.name === "NotFoundException" || err?.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

async function createSendGridDomain(providerConfig, domain) {
  const cfg = decryptJsonIfNeeded(providerConfig?.encryptedConfig);
  if (!cfg.apiKey) throw httpError(400, "SendGrid provider is missing an API key.");
  const existing = await sendGridRequest(cfg.apiKey, `/v3/whitelabel/domains?domain=${encodeURIComponent(domain)}`, { method: "GET" });
  const found = Array.isArray(existing) ? existing.find((item) => item.domain === domain) : null;
  const row = found || await sendGridRequest(cfg.apiKey, "/v3/whitelabel/domains", {
    method: "POST",
    body: {
      domain,
      automatic_security: true,
      default: false,
    },
  });
  return sendGridPayload(domain, row);
}

async function refreshSendGridDomain(providerConfig, identityName) {
  const cfg = decryptJsonIfNeeded(providerConfig?.encryptedConfig);
  if (!cfg.apiKey) throw httpError(400, "SendGrid provider is missing an API key.");
  const row = await sendGridRequest(cfg.apiKey, `/v3/whitelabel/domains/${identityName}`, { method: "GET" });
  return sendGridPayload(row.domain, row);
}

function sendGridPayload(domain, row) {
  return {
    providerIdentityName: String(row.id),
    providerIdentityArn: null,
    mailFromDomain: row.mail_cname?.host || null,
    dnsRecords: flattenSendGridRecords(row),
    providerVerified: Boolean(row.valid),
  };
}

function flattenSendGridRecords(row) {
  const entries = [];
  const dns = row.dns || {};
  for (const [key, record] of Object.entries(dns)) {
    if (!record?.host || !record?.data) continue;
    entries.push({
      type: String(record.type || "CNAME").toUpperCase(),
      host: record.host,
      value: record.data,
      purpose: `SendGrid ${key.replace(/_/g, " ")}`,
      status: record.valid ? "ok" : "pending",
    });
  }
  return entries;
}

async function sendGridRequest(apiKey, path, { method = "GET", body } = {}) {
  const res = await fetch(`https://api.sendgrid.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await readJson(res);
  if (!res.ok) throw httpError(res.status, `SendGrid domain request failed: ${providerMessage(data)}`);
  return data;
}

async function getMailgunDomain(providerConfig, domain) {
  const cfg = decryptJsonIfNeeded(providerConfig?.encryptedConfig);
  if (!cfg.apiKey) throw httpError(400, "Mailgun provider is missing an API key.");
  const region = cfg.region || "us";
  const base = region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
  const res = await fetch(`${base}/v4/domains/${encodeURIComponent(domain)}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`api:${cfg.apiKey}`).toString("base64")}`,
    },
  });
  const data = await readJson(res);
  if (!res.ok) throw httpError(res.status, `Mailgun domain request failed: ${providerMessage(data)}`);
  const domainData = data.domain || data;
  return {
    providerIdentityName: domain,
    providerIdentityArn: null,
    mailFromDomain: domainData.smtp_login || null,
    dnsRecords: mailgunRecords(data),
    providerVerified: String(domainData.state || "").toLowerCase() === "active",
  };
}

function mailgunRecords(data) {
  const records = [];
  const groups = [data.receiving_dns_records, data.sending_dns_records, data.dns_records].filter(Array.isArray);
  for (const group of groups) {
    for (const record of group) {
      records.push({
        type: String(record.record_type || record.type || "TXT").toUpperCase(),
        host: record.name || record.host || record.hostname,
        value: record.value || record.data,
        purpose: record.description || "Mailgun DNS record",
        status: record.valid === "valid" || record.is_active ? "ok" : "pending",
      });
    }
  }
  return records.filter((record) => record.host && record.value);
}

async function createPostmarkDomain(providerConfig, domain) {
  const cfg = decryptJsonIfNeeded(providerConfig?.encryptedConfig);
  if (!cfg.serverToken) throw httpError(400, "Postmark provider is missing a server token.");
  const created = await postmarkRequest(cfg.serverToken, "/domains", {
    method: "POST",
    body: { Name: domain },
    tolerateConflict: true,
  });
  const id = created?.ID || created?.Name || domain;
  return refreshPostmarkDomain(providerConfig, id);
}

async function refreshPostmarkDomain(providerConfig, identityName) {
  const cfg = decryptJsonIfNeeded(providerConfig?.encryptedConfig);
  if (!cfg.serverToken) throw httpError(400, "Postmark provider is missing a server token.");
  const row = await postmarkRequest(cfg.serverToken, `/domains/${identityName}`, { method: "GET" });
  return {
    providerIdentityName: String(row.ID || identityName),
    providerIdentityArn: null,
    mailFromDomain: row.ReturnPathDomain || null,
    dnsRecords: postmarkRecords(row),
    providerVerified: Boolean(row.DKIMVerified && row.ReturnPathDomainVerified),
  };
}

function postmarkRecords(row) {
  return [
    row.DKIMHost && row.DKIMTextValue && {
      type: "TXT",
      host: row.DKIMHost,
      value: row.DKIMTextValue,
      purpose: "Postmark DKIM",
      status: row.DKIMVerified ? "ok" : "pending",
    },
    row.ReturnPathDomain && row.ReturnPathDomainCNAMEValue && {
      type: "CNAME",
      host: row.ReturnPathDomain,
      value: row.ReturnPathDomainCNAMEValue,
      purpose: "Postmark return-path",
      status: row.ReturnPathDomainVerified ? "ok" : "pending",
    },
  ].filter(Boolean);
}

async function postmarkRequest(token, path, { method = "GET", body, tolerateConflict = false } = {}) {
  const res = await fetch(`https://api.postmarkapp.com${path}`, {
    method,
    headers: {
      "X-Postmark-Server-Token": token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await readJson(res);
  if (!res.ok) {
    const msg = providerMessage(data);
    if (tolerateConflict && /already exists/i.test(msg)) return { Name: body?.Name };
    throw httpError(res.status, `Postmark domain request failed: ${msg}`);
  }
  return data;
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_err) {
    return { message: text };
  }
}

function providerMessage(data) {
  return data?.message || data?.Message || data?.error || data?.errors?.[0]?.message || "provider error";
}

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

module.exports = {
  createDomainIdentity,
  deleteDomainIdentity,
  refreshDomainIdentity,
};
