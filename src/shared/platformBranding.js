const config = require("../config");

const CACHE_TTL_MS = 60 * 1000;
let cache = null;
let expiresAt = 0;
const locationCache = new Map();

function withoutPlatformSupport(value = {}) {
  return { ...value, supportEmail: "", supportPhone: "", supportUrl: "" };
}

async function getPlatformBranding({ fetchImpl = fetch, now = Date.now(), fresh = false } = {}) {
  if (!fresh && cache && now < expiresAt) return cache;
  const baseUrl = config.integrations.coreApiBaseUrl;
  if (!baseUrl || !config.internalApiSecret) return cache || {};

  try {
    const response = await fetchImpl(`${baseUrl}/internal/crm/platform-branding`, {
      headers: { "x-internal-api-secret": config.internalApiSecret },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    cache = body?.data && typeof body.data === "object" ? body.data : {};
    expiresAt = now + CACHE_TTL_MS;
    return cache;
  } catch {
    // Keep the last known identity during a short core-service interruption.
    // A missing cache simply leaves the stored template styling untouched.
    return cache || {};
  }
}

async function getEmailBranding(locationId, { fetchImpl = fetch, now = Date.now(), fresh = false } = {}) {
  const numericLocationId = Number(locationId);
  if (!Number.isFinite(numericLocationId) || numericLocationId <= 0) {
    return getPlatformBranding({ fetchImpl, now });
  }
  const cached = locationCache.get(numericLocationId);
  if (!fresh && cached && now < cached.expiresAt) return cached.value;

  const baseUrl = config.integrations.coreApiBaseUrl;
  if (!baseUrl || !config.internalApiSecret) {
    return cached?.value || withoutPlatformSupport(await getPlatformBranding({ fetchImpl, now }));
  }
  try {
    const response = await fetchImpl(`${baseUrl}/internal/crm/locations/${numericLocationId}/email-branding`, {
      headers: { "x-internal-api-secret": config.internalApiSecret },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const value = body?.data && typeof body.data === "object" ? body.data : {};
    locationCache.set(numericLocationId, { value, expiresAt: now + CACHE_TTL_MS });
    return value;
  } catch {
    return cached?.value || withoutPlatformSupport(await getPlatformBranding({ fetchImpl, now }));
  }
}

function resetCache() {
  cache = null;
  expiresAt = 0;
  locationCache.clear();
}

module.exports = { getEmailBranding, getPlatformBranding, resetCache };
