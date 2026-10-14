const config = require("../../config");

// Core owns location/catalog validation and the existing contact/lead records.
async function callCore(action, body, fetchImpl = fetch) {
  const response = await fetchImpl(`${config.integrations.coreApiBaseUrl}/internal/conversations/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-api-secret": config.internalApiSecret },
    body: JSON.stringify(body), signal: AbortSignal.timeout(25000),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    const error = new Error(payload.message || "Guest AI is temporarily unavailable.");
    error.statusCode = response.status;
    error.details = payload.details;
    throw error;
  }
  return payload.data;
}

module.exports = { callCore };
