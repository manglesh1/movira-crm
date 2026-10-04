const config = require("../../config");

function providerError(message, options = {}) {
  const error = new Error(message);
  error.code = options.code || "meta_send_failed";
  error.retryable = options.retryable === true;
  error.statusCode = options.statusCode || 502;
  error.providerCode = options.providerCode || null;
  return error;
}

async function sendText({ externalAccountId, recipientId, text, accessToken }, fetchImpl = fetch) {
  if (!externalAccountId || !recipientId || !text || !accessToken) {
    throw providerError("Meta send configuration is incomplete.", { code: "meta_send_configuration_invalid" });
  }
  const meta = config.integrations.meta;
  const url = `https://graph.facebook.com/${meta.graphVersion}/${encodeURIComponent(externalAccountId)}/messages`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: "RESPONSE", message: { text } }),
    });
  } catch {
    throw providerError("Meta could not be reached. The message will be retried.", { code: "meta_network_error", retryable: true });
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const providerCode = payload.error?.code || response.status;
    const retryable = response.status === 429 || response.status >= 500 || [1, 2, 4, 17, 32, 613].includes(Number(providerCode));
    throw providerError(
      retryable ? "Meta temporarily rejected the message. It will be retried." : "Meta rejected the message. Reconnect the channel or check the reply window.",
      { code: retryable ? "meta_send_retryable" : "meta_send_rejected", retryable, providerCode }
    );
  }
  const providerMessageId = payload.message_id || payload.id;
  if (!providerMessageId) throw providerError("Meta accepted the request without returning a message id.", { code: "meta_message_id_missing", retryable: true });
  return { providerMessageId: String(providerMessageId), recipientId: payload.recipient_id ? String(payload.recipient_id) : recipientId };
}

module.exports = { sendText, _internal: { providerError } };
