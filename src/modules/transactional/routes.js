const express = require("express");
const auth = require("../../shared/auth");
const authorizeLocation = require("../../shared/authorizeLocation");
const transactionalService = require("./service");
const templateService = require("./templateService");
const operationsService = require("./operationsService");

const router = express.Router();
router.use(auth, authorizeLocation({
  action: (req) => {
    if (req.method === "DELETE") return "crm:transactional:delete";
    if (req.path.includes("test-send") || req.path.includes("/messages")) return "crm:transactional:send";
    return `crm:transactional:${req.method === "GET" ? "read" : "write"}`;
  },
  requireLocation: true,
}));

function templateScope(req) {
  return { isSuperAdmin: Boolean(req.crmAuthz?.isSuperAdmin) };
}

router.get("/overview", (_req, res) => {
  res.json({
    success: true,
    data: {
      domain: "transactional",
      ownedByFrontend: "my-admin-app",
      queues: ["transactional-critical", "transactional-default"],
      status: "design-scaffold",
    },
  });
});

router.get("/queue-monitoring", async (req, res, next) => {
  try {
    const data = await operationsService.getQueueMonitoring(req.query || {});
    res.json({ success: true, data });
  } catch (err) {
    handleError(err, res, next);
  }
});

router.get("/sqs-worker-verification", async (_req, res, next) => {
  try {
    const data = await operationsService.getWorkerVerification();
    res.json({ success: true, data });
  } catch (err) {
    handleError(err, res, next);
  }
});

router.post("/sqs-worker-verification/probe", async (req, res, next) => {
  try {
    const data = await operationsService.probeQueues(req.body || {});
    res.json({ success: true, data });
  } catch (err) {
    handleError(err, res, next);
  }
});

router.get("/failed-messages", async (req, res, next) => {
  try {
    const data = await operationsService.listFailedMessages(req.query || {});
    res.json({ success: true, data });
  } catch (err) {
    handleError(err, res, next);
  }
});

router.post("/failed-messages/retry", async (req, res, next) => {
  try {
    const data = await operationsService.retryFailedMessages(req.body || {});
    res.json({ success: true, data });
  } catch (err) {
    handleError(err, res, next);
  }
});

router.post("/messages/retry-recoverable", async (req, res, next) => {
  try {
    const data = await operationsService.retryRecoverableMessages(req.body || {});
    res.json({ success: true, data });
  } catch (err) {
    handleError(err, res, next);
  }
});

function handleError(err, res, next) {
  if (err.statusCode) {
    return res.status(err.statusCode).json({ success: false, error: err.message });
  }
  return next(err);
}

router.get("/templates", async (req, res, next) => {
  try {
    const data = await templateService.listTemplates(req.query, templateScope(req));
    res.json({ success: true, data });
  } catch (err) {
    handleError(err, res, next);
  }
});

router.get("/templates/:id", async (req, res, next) => {
  try {
    const data = await templateService.getTemplate(req.params.id, {}, templateScope(req));
    res.json({ success: true, data });
  } catch (err) {
    handleError(err, res, next);
  }
});

router.post("/templates", async (req, res, next) => {
  try {
    const data = await templateService.createTemplate(req.body, req.user, templateScope(req));
    res.status(201).json({ success: true, data });
  } catch (err) {
    handleError(err, res, next);
  }
});

router.patch("/templates/:id", async (req, res, next) => {
  try {
    const data = await templateService.updateTemplate(req.params.id, req.body, req.user, templateScope(req));
    res.json({ success: true, data });
  } catch (err) {
    handleError(err, res, next);
  }
});

router.delete("/templates/:id", async (req, res, next) => {
  try {
    const data = await templateService.deleteTemplate(req.params.id, templateScope(req));
    res.json({ success: true, data });
  } catch (err) {
    handleError(err, res, next);
  }
});

router.post("/templates/:id/clone", async (req, res, next) => {
  try {
    const data = await templateService.cloneTemplate(req.params.id, req.body || {}, req.user, templateScope(req));
    res.status(201).json({ success: true, data });
  } catch (err) {
    handleError(err, res, next);
  }
});

router.post("/templates/:id/test-send", async (req, res, next) => {
  try {
    const data = await templateService.testSendTemplate(req.params.id, req.body || {}, templateScope(req));
    res.json({ success: true, data });
  } catch (err) {
    handleError(err, res, next);
  }
});

router.post("/templates/render", async (req, res, next) => {
  try {
    const data = await templateService.renderDraft(req.body || {});
    res.json({ success: true, data });
  } catch (err) {
    handleError(err, res, next);
  }
});

router.post("/messages", async (req, res, next) => {
  try {
    const result = await transactionalService.enqueueMessage(req.body);
    const message = result.message;
    res.status(result.duplicate ? 200 : 202).json({
      success: true,
      duplicate: result.duplicate,
      data: {
        id: message.id,
        status: message.status,
        channel: message.channel,
        priority: message.priority,
        templateKey: message.templateKey,
        idempotencyKey: message.idempotencyKey,
        enqueue: result.enqueue,
      },
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        error: err.message,
      });
    }
    return next(err);
  }
});

router.post("/messages/:id/retry", async (req, res, next) => {
  try {
    const data = await operationsService.retryMessage(req.params.id, req.body || {});
    res.json({ success: true, data });
  } catch (err) {
    handleError(err, res, next);
  }
});

module.exports = router;
