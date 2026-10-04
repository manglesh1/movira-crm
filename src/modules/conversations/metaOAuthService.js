const crypto = require("crypto");
const { Op } = require("sequelize");
const config = require("../../config");
const { getModels } = require("../../db/models");
const { encryptJson, decryptJson } = require("../../shared/credentialVault");

function error(message, statusCode = 400, code = "meta_oauth_error") {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function requireMetaConfig() {
  const meta = config.integrations.meta;
  const credentialsEncryptionReady = Boolean(config.credentialsEncryptionKey) || config.env !== "production";
  if (!meta.appId || !meta.appSecret || !meta.oauthRedirectUri || !config.webhooks.metaVerifyToken || !credentialsEncryptionReady) {
    throw error("Facebook and Instagram connections are temporarily unavailable. Please contact Movira support.", 503, "meta_not_configured");
  }
  return meta;
}

const hashState = (state) => crypto.createHash("sha256").update(String(state)).digest("hex");

async function graphRequest(path, options = {}, fetchImpl = fetch) {
  const meta = requireMetaConfig();
  const url = new URL(`https://graph.facebook.com/${meta.graphVersion}/${String(path).replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const response = await fetchImpl(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined,
    body: options.body ? new URLSearchParams(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const code = payload.error?.code ? `meta_${payload.error.code}` : "meta_request_failed";
    throw error("Meta could not complete this request. Check the account permissions and try again.", 502, code);
  }
  return payload;
}

async function beginOAuth({ locationId, userId }) {
  const meta = requireMetaConfig();
  const location = Number(locationId);
  const user = Number(userId);
  if (!Number.isInteger(location) || location < 1 || !Number.isInteger(user) || user < 1) throw error("Invalid OAuth context.");
  const state = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const { CrmConversationOauthState } = getModels();
  const attempt = await CrmConversationOauthState.create({
    locationId: location, userId: user, provider: "meta", stateHash: hashState(state), status: "pending", expiresAt,
  });
  const url = new URL(`https://www.facebook.com/${meta.graphVersion}/dialog/oauth`);
  url.searchParams.set("client_id", meta.appId);
  url.searchParams.set("redirect_uri", meta.oauthRedirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", meta.scopes.join(","));
  url.searchParams.set("response_type", "code");
  return { attemptId: attempt.id, authorizationUrl: url.toString(), expiresAt };
}

function discoveredAccounts(pages = []) {
  const privateAccounts = [];
  const safeAccounts = [];
  for (const page of pages) {
    if (!page?.id || !page?.access_token) continue;
    privateAccounts.push({ accountKey: `facebook:${page.id}`, channel: "facebook", externalAccountId: String(page.id), displayName: page.name || "Facebook Page", accessToken: page.access_token });
    safeAccounts.push({ accountKey: `facebook:${page.id}`, channel: "facebook", externalAccountId: String(page.id), displayName: page.name || "Facebook Page" });
    const instagram = page.instagram_business_account;
    if (instagram?.id) {
      const displayName = instagram.username ? `@${instagram.username}` : (instagram.name || `${page.name || "Instagram"} Instagram`);
      privateAccounts.push({ accountKey: `instagram:${instagram.id}`, channel: "instagram", externalAccountId: String(instagram.id), displayName, accessToken: page.access_token, parentPageId: String(page.id) });
      safeAccounts.push({ accountKey: `instagram:${instagram.id}`, channel: "instagram", externalAccountId: String(instagram.id), displayName, parentPageId: String(page.id) });
    }
  }
  return { privateAccounts, safeAccounts };
}

async function completeOAuth({ code, state }, fetchImpl = fetch) {
  if (!code || !state) throw error("Meta did not return the required OAuth values.", 400, "meta_callback_invalid");
  const meta = requireMetaConfig();
  const models = getModels();
  const attempt = await models.CrmConversationOauthState.findOne({
    where: { provider: "meta", stateHash: hashState(state), status: "pending", expiresAt: { [Op.gt]: new Date() } },
  });
  if (!attempt) throw error("This Meta connection request is invalid, expired, or already used.", 400, "meta_state_invalid");
  try {
    const token = await graphRequest("oauth/access_token", {
      query: { client_id: meta.appId, client_secret: meta.appSecret, redirect_uri: meta.oauthRedirectUri, code },
    }, fetchImpl);
    if (!token.access_token) throw error("Meta did not return an access token.", 502, "meta_token_missing");
    const result = await graphRequest("me/accounts", {
      query: {
        access_token: token.access_token,
        fields: "id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}",
        limit: 100,
      },
    }, fetchImpl);
    const accounts = discoveredAccounts(result.data || []);
    await attempt.update({
      status: "select_account", encryptedResult: encryptJson({ accounts: accounts.privateAccounts }),
      resultSafe: { accounts: accounts.safeAccounts }, expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    return { attemptId: attempt.id, locationId: attempt.locationId, accounts: accounts.safeAccounts };
  } catch (err) {
    await attempt.update({ status: "failed", lastErrorCode: err.code || "meta_callback_failed", lastErrorMessageSafe: err.message }).catch(() => {});
    throw err;
  }
}

async function getAttempt({ attemptId, locationId, userId }) {
  const { CrmConversationOauthState } = getModels();
  const attempt = await CrmConversationOauthState.findOne({ where: { id: attemptId, locationId, userId, provider: "meta" } });
  if (!attempt) throw error("Meta connection attempt not found.", 404, "meta_attempt_not_found");
  return {
    id: attempt.id, status: attempt.status, accounts: attempt.resultSafe?.accounts || [], expiresAt: attempt.expiresAt,
    error: attempt.lastErrorMessageSafe || null,
  };
}

function subscriptionForAccount(account) {
  if (account.channel === "instagram" && !account.parentPageId) {
    throw error(
      "This Instagram account is not linked to an eligible Facebook Page.",
      400,
      "meta_instagram_page_required"
    );
  }
  return {
    // Instagram accounts discovered through Facebook Login are subscribed via
    // their linked Page. The Instagram business account object does not expose
    // the /subscribed_apps edge for this token type.
    targetId: account.channel === "instagram" ? account.parentPageId : account.externalAccountId,
    // Facebook and Instagram share the linked Page's /subscribed_apps edge.
    // Meta replaces subscribed_fields on each POST, so always send the union;
    // otherwise reconnecting Instagram silently removes Messenger receipts.
    fields: "messages,messaging_postbacks,message_deliveries,message_reads",
  };
}

async function subscribeAccount(account, fetchImpl) {
  const subscription = subscriptionForAccount(account);
  await graphRequest(`${subscription.targetId}/subscribed_apps`, {
    method: "POST", body: { subscribed_fields: subscription.fields, access_token: account.accessToken },
  }, fetchImpl);
}

function activeAccountOwnershipWhere(account, locationId) {
  return {
    channel: account.channel,
    provider: "meta",
    externalAccountId: account.externalAccountId,
    locationId: { [Op.ne]: locationId },
    status: { [Op.ne]: "disconnected" },
  };
}

async function connectAccounts({ attemptId, locationId, userId, accountKeys }, fetchImpl = fetch) {
  const models = getModels();
  const attempt = await models.CrmConversationOauthState.findOne({
    where: { id: attemptId, locationId, userId, provider: "meta", status: "select_account", expiresAt: { [Op.gt]: new Date() } },
  });
  if (!attempt?.encryptedResult) throw error("Meta connection attempt is unavailable or expired.", 404, "meta_attempt_not_found");
  const selected = new Set(Array.isArray(accountKeys) ? accountKeys.map(String) : []);
  if (!selected.size) throw error("Select at least one Facebook or Instagram account.", 400, "meta_account_required");
  const accounts = decryptJson(attempt.encryptedResult).accounts || [];
  const chosen = accounts.filter((account) => selected.has(account.accountKey));
  if (chosen.length !== selected.size) throw error("One or more selected accounts are invalid.", 400, "meta_account_invalid");

  const connected = [];
  for (const account of chosen) {
    const ownedElsewhere = await models.CrmConversationChannelConnection.findOne({
      where: activeAccountOwnershipWhere(account, locationId),
    });
    if (ownedElsewhere) {
      throw error("This social account is already connected to another Movira location.", 409, "meta_account_already_connected");
    }
    await subscribeAccount(account, fetchImpl);
    const encryptedCredentials = encryptJson({ accessToken: account.accessToken, parentPageId: account.parentPageId || null });
    let connection = await models.CrmConversationChannelConnection.findOne({
      where: { locationId, channel: account.channel, provider: "meta", externalAccountId: account.externalAccountId },
    });
    const values = {
      locationId, channel: account.channel, provider: "meta", externalAccountId: account.externalAccountId,
      displayName: account.displayName, status: "connected", encryptedCredentials,
      grantedScopes: config.integrations.meta.scopes,
      capabilities: { receiveMessages: true, sendMessages: true, attachments: true, readReceipts: true },
      connectedByUserId: userId, disconnectedAt: null, lastErrorCode: null, lastErrorMessageSafe: null,
    };
    if (connection) await connection.update(values);
    else connection = await models.CrmConversationChannelConnection.create(values);
    connected.push({ id: connection.id, channel: connection.channel, externalAccountId: connection.externalAccountId, displayName: connection.displayName, status: connection.status });
  }
  await attempt.update({ status: "completed", consumedAt: new Date(), encryptedResult: null, resultSafe: { connected } });
  return connected;
}

async function disconnectConnection({ connectionId, locationId }, fetchImpl = fetch) {
  const { CrmConversationChannelConnection } = getModels();
  const connection = await CrmConversationChannelConnection.findOne({ where: { id: connectionId, locationId } });
  if (!connection) throw error("Channel connection not found.", 404, "channel_connection_not_found");
  let providerUnsubscribed = false;
  if (connection.provider === "meta" && connection.encryptedCredentials) {
    try {
      const credentials = decryptJson(connection.encryptedCredentials);
      await graphRequest(`${connection.externalAccountId}/subscribed_apps`, {
        method: "DELETE", body: { access_token: credentials.accessToken },
      }, fetchImpl);
      providerUnsubscribed = true;
    } catch {
      // Local credentials must still be revoked. Meta subscriptions can be
      // cleaned up separately if the provider token has already expired.
    }
  }
  const unsubscribeUnconfirmed = connection.provider === "meta" && !providerUnsubscribed;
  await connection.update({
    status: "disconnected", encryptedCredentials: null, capabilities: {}, disconnectedAt: new Date(),
    lastErrorCode: unsubscribeUnconfirmed ? "provider_unsubscribe_unconfirmed" : null,
    lastErrorMessageSafe: unsubscribeUnconfirmed ? "Local access was revoked; provider unsubscribe could not be confirmed." : null,
  });
  return { id: connection.id, status: connection.status, providerUnsubscribed };
}

module.exports = {
  beginOAuth, completeOAuth, getAttempt, connectAccounts, disconnectConnection,
  _internal: { discoveredAccounts, graphRequest, hashState, subscriptionForAccount, activeAccountOwnershipWhere },
};
