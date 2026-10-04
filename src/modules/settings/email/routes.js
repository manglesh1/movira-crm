const express = require("express");
const auth = require("../../../shared/auth");
const authorizeLocation = require("../../../shared/authorizeLocation");
const service = require("./service");
const replyForwardService = require("./replyForwardService");
const analyticsService = require("./analyticsService");

const router = express.Router();
router.use(auth, authorizeLocation({
  action: (req) => `crm:settings:${req.method === "GET" ? "read" : "write"}`,
  requireLocation: true,
}));

function sendError(res, err) {
  return res.status(err.statusCode).json({
    success: false,
    error: err.message,
    errors: err.errors || [],
    ...(err.code ? { code: err.code } : {}),
    ...(err.details ? { details: err.details } : {}),
    ...(err.requiredActions ? { requiredActions: err.requiredActions } : {}),
  });
}

router.get("/", async (req, res, next) => {
  try {
    const data = await service.getEmailSettings(req.query);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.post("/providers", async (req, res, next) => {
  try {
    const data = await service.createProvider(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

// Pre-save credential check — runs the protocol-level handshake for the
// chosen provider type without persisting anything. Returns { ok, message }.
router.post("/providers/verify-config", async (req, res, next) => {
  try {
    const data = await service.verifyProviderConfig(req.body);
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/providers/:id/test", async (req, res, next) => {
  try {
    const data = await service.testProvider(req.params.id, req.body, { locationId: req.crmLocationId });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.delete("/providers/:id", async (req, res, next) => {
  try {
    const removed = await service.deleteProvider(req.params.id, { locationId: req.crmLocationId });
    res.json({ success: true, data: { removed } });
  } catch (err) {
    next(err);
  }
});

// ── Sending domains ──────────────────────────────────────────────────

router.get("/domains", async (req, res, next) => {
  try {
    const data = await service.listDomains({ locationId: req.query.locationId });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.get("/domains/:id", async (req, res, next) => {
  try {
    const data = await service.getDomain(req.params.id, { locationId: req.crmLocationId });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/domains", async (req, res, next) => {
  try {
    const data = await service.createDomain(req.body);
    res.status(201).json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/domains/:id/verify", async (req, res, next) => {
  try {
    const data = await service.verifyDomain(req.params.id, { locationId: req.crmLocationId });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/domains/:id/set-default", async (req, res, next) => {
  try {
    const data = await service.setDefaultDomain(req.params.id, { locationId: req.crmLocationId });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.patch("/domains/:id/warmup", async (req, res, next) => {
  try {
    const data = await service.updateWarmupControl(req.params.id, req.body || {}, { locationId: req.crmLocationId });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.delete("/domains/:id", async (req, res, next) => {
  try {
    await service.deleteDomain(req.params.id, { locationId: req.crmLocationId });
    res.json({ success: true });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

// ── Use-case → domain routing ────────────────────────────────────────

router.get("/routes", async (req, res, next) => {
  try {
    const data = await service.listDomainRoutes({ locationId: req.query.locationId });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

// ── Reply / Forward / BCC settings ──────────────────────────────────

router.get("/reply-forward", async (req, res, next) => {
  try {
    const data = await replyForwardService.getReplyForward(req.query);
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.put("/reply-forward", async (req, res, next) => {
  try {
    const locationId = req.body?.locationId || req.query?.locationId;
    const data = await replyForwardService.updateReplyForward({ ...req.body, locationId });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

// ── Analytics + Bounce classification (aggregated views) ────────────

router.get("/analytics", async (req, res, next) => {
  try {
    const data = await analyticsService.getEmailAnalytics(req.query);
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.get("/bounce-classification", async (req, res, next) => {
  try {
    const data = await analyticsService.getBounceClassification(req.query);
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.patch("/routes/:id", async (req, res, next) => {
  try {
    const data = await service.updateDomainRoute(req.params.id, req.body, { locationId: req.crmLocationId });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

module.exports = router;
