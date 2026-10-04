const express = require("express");
const auth = require("../../shared/auth");
const authorizeLocation = require("../../shared/authorizeLocation");
const service = require("./service");
const metaOAuthService = require("./metaOAuthService");
const config = require("../../config");
const outboundService = require("./outboundService");
const webchatService = require("./webchatService");

const router = express.Router();

// Meta redirects the browser here, so this callback is authenticated by the
// one-time OAuth state rather than the user's API bearer token.
router.get("/meta/oauth/callback", async (req, res, next) => {
  try {
    if (req.query.error) {
      const denied = new Error("Meta connection was cancelled or denied.");
      denied.statusCode = 400;
      denied.code = "meta_oauth_denied";
      throw denied;
    }
    const data = await metaOAuthService.completeOAuth(req.query);
    if (config.integrations.meta.oauthSuccessRedirect) {
      const redirect = new URL(config.integrations.meta.oauthSuccessRedirect);
      redirect.searchParams.set("metaAttemptId", data.attemptId);
      return res.redirect(302, redirect.toString());
    }
    return res.json({ success: true, data });
  } catch (error) {
    if (error.statusCode) return sendError(res, error);
    return next(error);
  }
});

// Dedicated conversation permissions will replace these compatibility actions
// after they are added to the core permission registry and admin UI.
router.use(auth, authorizeLocation({
  action: (req) => (req.method === "GET" ? "crm:read" : "crm:contacts:write"),
  requireLocation: true,
}));

function actorUserId(req) {
  const value = Number(req.user?.id || req.user?.user_id);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function sendError(res, error) {
  return res.status(error.statusCode || 500).json({
    success: false,
    error: error.code || "internal_error",
    message: error.message || "Internal server error",
  });
}

function handler(fn, status = 200) {
  return async (req, res, next) => {
    try {
      const data = await fn(req);
      return res.status(status).json({ success: true, data });
    } catch (error) {
      if (error.statusCode) return sendError(res, error);
      return next(error);
    }
  };
}

router.get("/channels", handler((req) => service.listChannels(req.query)));
router.post("/channels/webchat", handler((req) => webchatService.configure({
  locationId: req.body?.locationId || req.query.locationId,
  userId: actorUserId(req),
  displayName: req.body?.displayName,
  settings: req.body?.settings,
}), 201));
router.patch("/channels/webchat/:connectionId", handler((req) => webchatService.updateConfiguration({
  connectionId: req.params.connectionId,
  locationId: req.body?.locationId || req.query.locationId,
  displayName: req.body?.displayName,
  settings: req.body?.settings,
})));
router.post("/channels/meta/oauth/start", handler((req) => metaOAuthService.beginOAuth({
  locationId: req.body?.locationId || req.query.locationId,
  userId: actorUserId(req),
}), 201));
router.get("/channels/meta/oauth/:attemptId", handler((req) => metaOAuthService.getAttempt({
  attemptId: req.params.attemptId,
  locationId: Number(req.query.locationId),
  userId: actorUserId(req),
})));
router.post("/channels/meta/oauth/:attemptId/connect", handler((req) => metaOAuthService.connectAccounts({
  attemptId: req.params.attemptId,
  locationId: Number(req.body?.locationId || req.query.locationId),
  userId: actorUserId(req),
  accountKeys: req.body?.accountKeys,
})));
router.delete("/channels/:connectionId", handler((req) => metaOAuthService.disconnectConnection({
  connectionId: req.params.connectionId,
  locationId: Number(req.query.locationId),
})));
router.get("/events/stream", async (req, res, next) => {
  let cursor = req.headers["last-event-id"] || req.query.cursor || null;
  try {
    const first = await outboundService.listEvents({ ...req.query, cursor, limit: 100 });
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    let closed = false;
    let polling = false;
    const writeBatch = (data) => {
      if (!data.items.length || closed) return;
      cursor = data.pageInfo.nextCursor;
      res.write(`id: ${cursor}\n`);
      res.write("event: conversations\n");
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    writeBatch(first);
    const poll = async () => {
      if (closed || polling) return;
      polling = true;
      try {
        const data = await outboundService.listEvents({ ...req.query, cursor, limit: 100 });
        writeBatch(data);
      } catch (error) {
        req.log?.warn?.({ err: error }, "conversation event stream poll failed");
        if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ error: "event_feed_unavailable" })}\n\n`);
      } finally {
        polling = false;
      }
    };
    const pollTimer = setInterval(poll, 2000);
    const heartbeatTimer = setInterval(() => { if (!closed) res.write(": keep-alive\n\n"); }, 15000);
    req.on("close", () => {
      closed = true;
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
    });
  } catch (error) {
    if (error.statusCode) return sendError(res, error);
    return next(error);
  }
});
router.get("/events", handler((req) => outboundService.listEvents(req.query)));
router.get("/workspace", handler((req) => service.getWorkspace(req.query)));
router.patch("/workspace", handler((req) => service.updateWorkspace({ ...req.query, ...(req.body || {}) }, actorUserId(req))));
router.get("/routing-rules", handler((req) => service.listRoutingRules(req.query)));
router.post("/routing-rules", handler((req) => service.createRoutingRule({ ...req.query, ...(req.body || {}) }, actorUserId(req)), 201));
router.patch("/routing-rules/:ruleId", handler((req) => service.updateRoutingRule(req.params.ruleId, { ...req.query, ...(req.body || {}) })));
router.delete("/routing-rules/:ruleId", handler((req) => service.deleteRoutingRule(req.params.ruleId, req.query)));
router.get("/saved-replies", handler((req) => service.listSavedReplies(req.query)));
router.post("/saved-replies", handler((req) => service.createSavedReply({ ...req.query, ...(req.body || {}) }, actorUserId(req)), 201));
router.patch("/saved-replies/:replyId", handler((req) => service.updateSavedReply(req.params.replyId, { ...req.query, ...(req.body || {}) })));
router.delete("/saved-replies/:replyId", handler((req) => service.deleteSavedReply(req.params.replyId, req.query)));
router.get("/automation-rules", handler((req) => service.listAutomationRules(req.query)));
router.post("/automation-rules", handler((req) => service.createAutomationRule({ ...req.query, ...(req.body || {}) }, actorUserId(req)), 201));
router.patch("/automation-rules/:ruleId", handler((req) => service.updateAutomationRule(req.params.ruleId, { ...req.query, ...(req.body || {}) })));
router.delete("/automation-rules/:ruleId", handler((req) => service.deleteAutomationRule(req.params.ruleId, req.query)));
router.get("/analytics", handler((req) => service.getAnalytics(req.query)));
router.get("/", handler((req) => service.listConversations(req.query)));
router.get("/:id", handler((req) => service.getConversation(req.params.id, req.query)));
router.get("/:id/messages", handler((req) => service.listMessages(req.params.id, req.query)));
router.post("/:id/messages", handler((req) => outboundService.queueReply(
  req.params.id,
  { ...req.query, ...(req.body || {}) },
  actorUserId(req),
  req.headers["idempotency-key"]
), 202));
router.post("/:id/notes", handler((req) => service.addInternalNote(req.params.id, { ...req.query, ...(req.body || {}) }, actorUserId(req)), 201));
router.patch("/:id/assignment", handler((req) => service.updateAssignment(req.params.id, { ...req.query, ...(req.body || {}) }, actorUserId(req))));
router.patch("/:id/status", handler((req) => service.updateStatus(req.params.id, { ...req.query, ...(req.body || {}) })));
router.post("/:id/read", handler((req) => service.markRead(req.params.id, { ...req.query, ...(req.body || {}) })));

module.exports = router;
