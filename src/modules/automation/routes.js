const express = require("express");
const auth = require("../../shared/auth");
const authorizeLocation = require("../../shared/authorizeLocation");
const service = require("./service");

const router = express.Router();
router.use(auth, authorizeLocation({
  action: (req) => {
    if (req.method === "DELETE") return "crm:automation:delete";
    if (req.path.includes("/publish")) return "crm:automation:publish";
    return `crm:automation:${req.method === "GET" ? "read" : "write"}`;
  },
  requireLocation: true,
}));

function sendError(res, err) {
  return res.status(err.statusCode || 500).json({
    success: false,
    error: err.message || "Internal server error",
    code: err.code || undefined,
    errors: err.errors || [],
  });
}

router.get("/", async (req, res, next) => {
  try {
    const data = await service.listWorkflows(req.query || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.get("/stats", async (req, res, next) => {
  try {
    const data = await service.getStats(req.query || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.get("/runs", async (req, res, next) => {
  try {
    const data = await service.listRuns(req.query || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const data = await service.createWorkflow({ ...req.body, locationId: req.body.locationId || req.query.locationId });
    res.status(201).json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const data = await service.getWorkflow(req.params.id, req.query || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const data = await service.updateWorkflow(req.params.id, { ...req.body, locationId: req.body.locationId || req.query.locationId });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const data = await service.deleteWorkflow(req.params.id, req.query || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/:id/test", async (req, res, next) => {
  try {
    const data = await service.testWorkflow(req.params.id, { ...req.body, locationId: req.body.locationId || req.query.locationId });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/:id/enroll", async (req, res, next) => {
  try {
    const data = await service.enrollWorkflow(req.params.id, { ...req.body, locationId: req.body.locationId || req.query.locationId });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

module.exports = router;
