const crypto = require("crypto");
const config = require("../config");

function decodeKey(configured, label) {
  if (configured) {
    const decoded = Buffer.from(configured, "base64");
    if (decoded.length !== 32) throw new Error(`${label} must be a base64-encoded 32-byte key.`);
    return decoded;
  }
  return null;
}

function currentKey() {
  const configured = String(config.credentialsEncryptionKey || "").trim();
  const decoded = decodeKey(configured, "CRM_CREDENTIALS_ENCRYPTION_KEY");
  if (decoded) return decoded;
  if (config.env === "production") throw new Error("CRM_CREDENTIALS_ENCRYPTION_KEY is required for provider credentials.");
  return crypto.createHash("sha256").update(`movira-dev:${config.jwtSecret}`).digest();
}

function keyId() {
  const value = String(config.credentialsEncryptionKeyId || "primary").trim();
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(value)) throw new Error("CRM_CREDENTIALS_ENCRYPTION_KEY_ID is invalid.");
  return value;
}

function keyForId(id) {
  if (id === keyId()) return currentKey();
  let previous = {};
  try { previous = JSON.parse(config.credentialsPreviousEncryptionKeys || "{}"); } catch (_error) {
    throw new Error("CRM_CREDENTIALS_PREVIOUS_KEYS must be a JSON object of key IDs to base64 keys.");
  }
  const key = decodeKey(String(previous[id] || "").trim(), `Previous credential key ${id}`);
  if (!key) throw new Error(`Credential encryption key "${id}" is not configured.`);
  return key;
}

function encryptJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", currentKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2.${keyId()}.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decryptJson(value) {
  const parts = String(value || "").split(".");
  const version = parts[0];
  const encryptedKey = version === "v2" ? keyForId(parts[1]) : currentKey();
  const [ivValue, tagValue, encryptedValue] = version === "v2" ? parts.slice(2) : parts.slice(1);
  if (!['v1', 'v2'].includes(version) || !ivValue || !tagValue || !encryptedValue) throw new Error("Encrypted credential payload is invalid.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptedKey, Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

function isEncrypted(value) {
  return typeof value === "string" && /^(v1|v2)\./.test(value);
}

function decryptJsonIfNeeded(value) {
  if (isEncrypted(value)) return decryptJson(value);
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

module.exports = { decryptJson, decryptJsonIfNeeded, encryptJson, isEncrypted };
