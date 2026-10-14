const config = require("../config");
const { isMoviraControlMessage } = require("./communicationScope");

const CACHE_TTL_MS = 5000;
const cache = new Map();

function policyError(kind) {
  const label = kind === "marketing" ? "Marketing" : "Transactional";
  const error = new Error(
    `${label} email is disabled for this location. Enable it in Location settings or CRM Email Providers before sending.`
  );
  error.statusCode = 409;
  error.code = `${kind}_email_disabled`;
  return error;
}

function isMoviraControlEvent(input = {}) {
  return isMoviraControlMessage(input)
    || String(input.eventType || "").trim().toLowerCase().startsWith("saas.")
    || String(input.sourceSystem || "").trim().toLowerCase() === "movira-control";
}

async function getPreferences(locationId, { fresh = false } = {}) {
  const id = Number(locationId);
  if (!Number.isInteger(id) || id < 1) {
    const error = new Error("A valid locationId is required to evaluate email delivery policy.");
    error.statusCode = 400;
    error.code = "location_id_required";
    throw error;
  }

  const cached = cache.get(id);
  if (!fresh && cached && cached.expiresAt > Date.now()) return cached.value;

  const response = await fetch(
    `${config.integrations.coreApiBaseUrl}/internal/crm/locations/${id}/email-preferences`,
    {
      headers: { "x-internal-api-secret": config.internalApiSecret },
      signal: AbortSignal.timeout(5000),
    }
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.data) {
    const error = new Error("Email delivery policy could not be verified. No email was sent.");
    error.statusCode = 503;
    error.code = "email_delivery_policy_unavailable";
    throw error;
  }

  const value = {
    transactionalEmailEnabled: payload.data.transactionalEmailEnabled === true,
    marketingEmailEnabled: payload.data.marketingEmailEnabled === true,
  };
  cache.set(id, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

async function assertEnabled(kind, input = {}, options = {}) {
  if (kind === "transactional" && isMoviraControlEvent(input)) return true;
  const preferences = await getPreferences(input.locationId, options);
  const enabled = kind === "marketing"
    ? preferences.marketingEmailEnabled
    : preferences.transactionalEmailEnabled;
  if (!enabled) throw policyError(kind);
  return true;
}

module.exports = {
  assertEnabled,
  getPreferences,
  isMoviraControlEvent,
  _clearCache: () => cache.clear(),
};
