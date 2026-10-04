const express = require("express");
const path = require("path");
const webchat = require("./webchatService");

const router = express.Router();
const rateBuckets = new Map();

function publicRateLimit(req, res, next) {
  const now = Date.now();
  const key = `${req.ip}:${req.params.widgetKey || "asset"}`;
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
  } else if (bucket.count >= 120) {
    res.set("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
    return res.status(429).json({ success: false, error: "rate_limited", message: "Too many chat requests. Please wait a moment." });
  } else {
    bucket.count += 1;
  }
  if (rateBuckets.size > 5000) {
    for (const [bucketKey, value] of rateBuckets) if (value.resetAt <= now) rateBuckets.delete(bucketKey);
  }
  return next();
}

function requestOrigin(req) {
  return req.get("origin") || req.get("referer") || "";
}

function sendError(res, error) {
  return res.status(error.statusCode || 500).json({
    success: false,
    error: error.code || "internal_error",
    message: error.statusCode ? error.message : "Chat is temporarily unavailable.",
  });
}

function publicHandler(fn, status = 200) {
  return async (req, res, next) => {
    try {
      const data = await fn(req);
      const origin = requestOrigin(req);
      if (origin) res.set("Access-Control-Allow-Origin", new URL(origin).origin);
      res.set("Vary", "Origin");
      return res.status(status).json({ success: true, data });
    } catch (error) {
      if (error.statusCode) return sendError(res, error);
      return next(error);
    }
  };
}

router.get("/widget.js", (_req, res) => {
  res.set({ "Cross-Origin-Resource-Policy": "cross-origin", "Cache-Control": "public, max-age=300" });
  res.sendFile(path.join(__dirname, "webchatWidget.js"));
});

router.use("/:widgetKey", publicRateLimit);

router.options("/:widgetKey/*", async (req, res) => {
  try {
    await webchat.getPublicConfig(req.params.widgetKey, requestOrigin(req));
    const origin = requestOrigin(req);
    if (origin) res.set("Access-Control-Allow-Origin", new URL(origin).origin);
    res.set({
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-Session-Token,Idempotency-Key",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    });
    return res.sendStatus(204);
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/:widgetKey/config", publicHandler((req) => webchat.getPublicConfig(req.params.widgetKey, requestOrigin(req))));
router.post("/:widgetKey/sessions", publicHandler((req) => webchat.startSession({
  widgetKey: req.params.widgetKey,
  origin: requestOrigin(req),
  visitor: req.body?.visitor,
  sessionToken: req.body?.sessionToken,
}), 201));
router.get("/:widgetKey/messages", publicHandler((req) => webchat.listVisitorMessages({
  widgetKey: req.params.widgetKey,
  origin: requestOrigin(req),
  sessionToken: req.get("X-Session-Token"),
  after: req.query.after,
})));
router.post("/:widgetKey/messages", publicHandler((req) => webchat.addVisitorMessage({
  widgetKey: req.params.widgetKey,
  origin: requestOrigin(req),
  sessionToken: req.get("X-Session-Token"),
  idempotencyKey: req.get("Idempotency-Key"),
  textBody: req.body?.textBody,
}), 201));

module.exports = router;
