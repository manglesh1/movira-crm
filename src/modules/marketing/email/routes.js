const express = require("express");
const auth = require("../../../shared/auth");
const authorizeLocation = require("../../../shared/authorizeLocation");
const service = require("./service");
const testHarnessService = require("./testHarnessService");
const queueMonitoringService = require("./queueMonitoringService");
const sqsWorkerVerificationService = require("./sqsWorkerVerificationService");
const sesWebhookService = require("../../webhooks/sesService");
const auditService = require("../../audit/service");
const rssCampaignService = require("./rssCampaignService");

const router = express.Router();
router.use(auth, authorizeLocation({
  action: (req) => {
    if (req.method === "DELETE") return "crm:marketing:delete";
    if (
      req.path.includes("test-send") ||
      req.path.includes("/queue") ||
      req.path.includes("/retry") ||
      req.path.includes("/resume")
    ) {
      return "crm:marketing:send";
    }
    return `crm:marketing:${req.method === "GET" ? "read" : "write"}`;
  },
  requireLocation: true,
}));

function sendError(res, err) {
  return res.status(err.statusCode).json({
    success: false,
    error: err.message,
    errors: err.errors || [],
  });
}

function locationFrom(req, data) {
  return data?.locationId || data?.campaign?.locationId || req.body?.locationId || req.query?.locationId || null;
}

async function safeAudit(req, input) {
  try {
    await auditService.recordAuditLog({
      ...auditService.requestContext(req),
      ...input,
      locationId: input.locationId || locationFrom(req, input.data),
    });
  } catch (err) {
    req.log?.warn?.({ err, audit: input }, "audit log write skipped");
  }
}

router.get("/rss-campaigns", async (req, res, next) => {
  try { res.json({ success: true, data: await rssCampaignService.list(req.query || {}) }); } catch (err) { if (err.statusCode) return sendError(res, err); return next(err); }
});
router.post("/rss-campaigns", async (req, res, next) => {
  try {
    const data = await rssCampaignService.create({ ...(req.body || {}), locationId: req.body?.locationId || req.query.locationId });
    await safeAudit(req, { action: "rss_campaign_created", entityType: "rss_campaign", entityId: data.id, entityName: data.name, data });
    res.status(201).json({ success: true, data });
  } catch (err) { if (err.statusCode) return sendError(res, err); return next(err); }
});
router.patch("/rss-campaigns/:id", async (req, res, next) => {
  try { res.json({ success: true, data: await rssCampaignService.update(req.params.id, { ...(req.body || {}), locationId: req.body?.locationId || req.query.locationId }) }); } catch (err) { if (err.statusCode) return sendError(res, err); return next(err); }
});
router.delete("/rss-campaigns/:id", async (req, res, next) => {
  try { res.json({ success: true, data: await rssCampaignService.remove(req.params.id, req.query || {}) }); } catch (err) { if (err.statusCode) return sendError(res, err); return next(err); }
});
router.post("/rss-campaigns/:id/poll", async (req, res, next) => {
  try { res.status(202).json({ success: true, data: await rssCampaignService.poll(req.params.id, { ...(req.body || {}), locationId: req.body?.locationId || req.query.locationId }) }); } catch (err) { if (err.statusCode) return sendError(res, err); return next(err); }
});

// ── Local Test Harness ─────────────────────────────────────────────

router.get("/test-harness", async (req, res, next) => {
  try {
    const data = await testHarnessService.getHarnessStatus(req.query || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/test-harness/seed", async (req, res, next) => {
  try {
    const data = await testHarnessService.seedHarnessScenario({
      ...req.body,
      locationId: req.body.locationId || req.query.locationId,
    });
    res.status(201).json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/test-harness/campaigns/:id/process", async (req, res, next) => {
  try {
    const data = await testHarnessService.processHarnessCampaign(req.params.id, req.body || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/test-harness/messages/:id/process", async (req, res, next) => {
  try {
    const data = await testHarnessService.processHarnessMessage(req.params.id, req.body || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/test-harness/messages/:id/events", async (req, res, next) => {
  try {
    const data = await testHarnessService.simulateHarnessEvent(req.params.id, req.body || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

// ── Queue Monitoring ───────────────────────────────────────────────

router.get("/queue-monitoring", async (req, res, next) => {
  try {
    const data = await queueMonitoringService.getQueueMonitoring(req.query || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.get("/sqs-worker-verification", async (_req, res, next) => {
  try {
    const data = await sqsWorkerVerificationService.getWorkerVerification();
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/sqs-worker-verification/probe", async (req, res, next) => {
  try {
    const data = await sqsWorkerVerificationService.probeSqsQueues(req.body || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

// ── SES Webhook Simulator ──────────────────────────────────────────

router.get("/ses-webhook-simulator/messages", async (req, res, next) => {
  try {
    const data = await sesWebhookService.listSimulatorMessages(req.query || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/ses-webhook-simulator/simulate", async (req, res, next) => {
  try {
    const data = await sesWebhookService.simulateSesWebhook(req.body || {});
    await safeAudit(req, {
      action: "ses_webhook_simulated",
      entityType: "marketing_message",
      entityId: req.body?.messageId || null,
      metadata: { eventType: req.body?.eventType || req.body?.type || null, result: data?.result?.ok ?? null },
    });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

// ── Audit Logs ─────────────────────────────────────────────────────

router.get("/audit-logs", async (req, res, next) => {
  try {
    const data = await auditService.listAuditLogs(req.query || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

// ── Folders ─────────────────────────────────────────────────────────

router.get("/folders", async (req, res, next) => {
  try {
    const data = await service.listFolders(req.query);
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/folders", async (req, res, next) => {
  try {
    const data = await service.createFolder({ ...req.body, locationId: req.body.locationId || req.query.locationId });
    await safeAudit(req, {
      action: "folder_created",
      entityType: "marketing_folder",
      entityId: data.id,
      entityName: data.name,
      data,
      metadata: { kind: data.kind, parentId: data.parentId || null },
    });
    res.status(201).json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.delete("/folders/:id", async (req, res, next) => {
  try {
    const data = await service.deleteFolder(req.params.id);
    await safeAudit(req, {
      action: "folder_deleted",
      entityType: "marketing_folder",
      entityId: req.params.id,
      entityName: data?.name || null,
      data,
      metadata: { kind: data?.kind || null },
    });
    res.json({ success: true });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

// ── Assets ─────────────────────────────────────────────────────────

router.get("/assets", async (req, res, next) => {
  try {
    const data = await service.listAssets(req.query);
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/assets", async (req, res, next) => {
  try {
    const data = await service.createAsset({
      ...req.body,
      locationId: req.body.locationId || req.query.locationId,
      user: req.user,
    });
    await safeAudit(req, {
      action: "asset_created",
      entityType: "marketing_asset",
      entityId: data.id,
      entityName: data.name,
      data,
      metadata: { assetType: data.assetType, folderId: data.folderId || null, source: data.source },
    });
    res.status(201).json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/assets/upload", async (req, res, next) => {
  try {
    const data = await service.uploadAsset({
      ...req.body,
      locationId: req.body.locationId || req.query.locationId,
      user: req.user,
    });
    await safeAudit(req, {
      action: "asset_uploaded",
      entityType: "marketing_asset",
      entityId: data.id,
      entityName: data.name,
      data,
      metadata: { assetType: data.assetType, mimeType: data.mimeType, sizeBytes: data.sizeBytes },
    });
    res.status(201).json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.patch("/assets/:id", async (req, res, next) => {
  try {
    const data = await service.updateAsset(req.params.id, req.body || {});
    await safeAudit(req, {
      action: "asset_updated",
      entityType: "marketing_asset",
      entityId: data.id,
      entityName: data.name,
      data,
      metadata: { changedFields: Object.keys(req.body || {}), assetType: data.assetType },
    });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.delete("/assets/:id", async (req, res, next) => {
  try {
    const data = await service.deleteAsset(req.params.id);
    await safeAudit(req, {
      action: "asset_deleted",
      entityType: "marketing_asset",
      entityId: req.params.id,
      entityName: data?.name || null,
      data,
      metadata: { assetType: data?.assetType || null },
    });
    res.json({ success: true });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

// ── Saved Sections / Blocks ────────────────────────────────────────

router.get("/snippets", async (req, res, next) => {
  try {
    const data = await service.listSnippets(req.query);
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/snippets", async (req, res, next) => {
  try {
    const data = await service.createSnippet({
      ...req.body,
      locationId: req.body.locationId || req.query.locationId,
      user: req.user,
    });
    await safeAudit(req, {
      action: "snippet_created",
      entityType: "marketing_snippet",
      entityId: data.id,
      entityName: data.name,
      data,
      metadata: { snippetType: data.snippetType, category: data.category },
    });
    res.status(201).json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.patch("/snippets/:id", async (req, res, next) => {
  try {
    const data = await service.updateSnippet(req.params.id, req.body || {});
    await safeAudit(req, {
      action: "snippet_updated",
      entityType: "marketing_snippet",
      entityId: data.id,
      entityName: data.name,
      data,
      metadata: { changedFields: Object.keys(req.body || {}), snippetType: data.snippetType },
    });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.delete("/snippets/:id", async (req, res, next) => {
  try {
    const data = await service.deleteSnippet(req.params.id);
    await safeAudit(req, {
      action: "snippet_deleted",
      entityType: "marketing_snippet",
      entityId: req.params.id,
      entityName: data?.name || null,
      data,
      metadata: { snippetType: data?.snippetType || null },
    });
    res.json({ success: true });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

// ── Templates ───────────────────────────────────────────────────────

router.get("/templates/builder/catalog", (_req, res) => {
  res.json({ success: true, data: service.getTemplateBuilderCatalog() });
});

router.get("/merge-tags", (req, res) => {
  res.json({ success: true, data: service.getMergeTagCatalog(req.query || {}) });
});

router.get("/templates", async (req, res, next) => {
  try {
    const data = await service.listTemplates(req.query);
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.get("/templates/:id", async (req, res, next) => {
  try {
    const data = await service.getTemplate(req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/templates", async (req, res, next) => {
  try {
    const data = await service.createTemplate({
      ...req.body,
      locationId: req.body.locationId || req.query.locationId,
      user: req.user,
    });
    await safeAudit(req, {
      action: "template_created",
      entityType: "marketing_template",
      entityId: data.id,
      entityName: data.name,
      data,
      metadata: { editorType: data.editorType, useCase: data.useCase, folderId: data.folderId || null },
    });
    res.status(201).json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/templates/render", async (req, res, next) => {
  try {
    const data = service.renderDraftTemplate(req.body || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/templates/test-send", async (req, res, next) => {
  try {
    const data = await service.sendTestDraftTemplate({
      ...(req.body || {}),
      locationId: req.body?.locationId || req.query.locationId,
    });
    await safeAudit(req, {
      action: "template_draft_test_sent",
      entityType: "marketing_template",
      entityName: req.body?.name || "Draft email",
      metadata: { to: data.to, subject: data.subject, useCase: data.useCase, provider: data.provider },
    });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/templates/:id/render", async (req, res, next) => {
  try {
    const data = await service.renderTemplate(req.params.id, req.body || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.get("/templates/:id/revisions", async (req, res, next) => {
  try {
    const data = await service.listTemplateRevisions(req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.get("/templates/:id/revisions/:revisionId", async (req, res, next) => {
  try {
    const data = await service.getTemplateRevision(req.params.id, req.params.revisionId);
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/templates/:id/revisions/:revisionId/restore", async (req, res, next) => {
  try {
    const data = await service.restoreTemplateRevision(req.params.id, req.params.revisionId, req.user);
    await safeAudit(req, {
      action: "template_revision_restored",
      entityType: "marketing_template",
      entityId: data.id,
      entityName: data.name,
      data,
      metadata: { revisionId: req.params.revisionId, useCase: data.useCase, editorType: data.editorType },
    });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/templates/:id/test-send", async (req, res, next) => {
  try {
    const data = await service.sendTestTemplate(req.params.id, req.body || {});
    await safeAudit(req, {
      action: "template_test_sent",
      entityType: "marketing_template",
      entityId: req.params.id,
      entityName: data.subject,
      metadata: { to: data.to, subject: data.subject, useCase: data.useCase, provider: data.provider },
    });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.patch("/templates/:id", async (req, res, next) => {
  try {
    const data = await service.updateTemplate(req.params.id, req.body, req.user);
    await safeAudit(req, {
      action: "template_updated",
      entityType: "marketing_template",
      entityId: data.id,
      entityName: data.name,
      data,
      metadata: { changedFields: Object.keys(req.body || {}), editorType: data.editorType, useCase: data.useCase },
    });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.delete("/templates/:id", async (req, res, next) => {
  try {
    const data = await service.deleteTemplate(req.params.id);
    await safeAudit(req, {
      action: "template_deleted",
      entityType: "marketing_template",
      entityId: req.params.id,
      entityName: data?.name || null,
      data,
      metadata: { editorType: data?.editorType || null, useCase: data?.useCase || null },
    });
    res.json({ success: true });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

// ── Campaigns ───────────────────────────────────────────────────────

router.get("/campaigns", async (req, res, next) => {
  try {
    const data = await service.listCampaigns(req.query);
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.get("/campaigns/:id/messages", async (req, res, next) => {
  try {
    const data = await service.listCampaignMessages(req.params.id, req.query || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.get("/campaigns/:id/drip-enrollments", async (req, res, next) => {
  try {
    const data = await service.listCampaignDripEnrollments(req.params.id, req.query || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.get("/messages/:id/events", async (req, res, next) => {
  try {
    const data = await service.listMessageEvents(req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.get("/failed-messages", async (req, res, next) => {
  try {
    const data = await service.listFailedMessages(req.query || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/failed-messages/retry", async (req, res, next) => {
  try {
    const data = await service.retryFailedMessages({
      ...req.body,
      locationId: req.body.locationId || req.query.locationId,
    });
    await safeAudit(req, {
      action: "failed_messages_retry_requested",
      entityType: "marketing_message",
      metadata: {
        totalRetried: data.totalRetried,
        totalFailed: data.totalFailed,
        campaignId: req.body?.campaignId || null,
        failureGroup: req.body?.failureGroup || null,
      },
    });
    res.status(202).json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/campaigns", async (req, res, next) => {
  try {
    const data = await service.createCampaign({
      ...req.body,
      locationId: req.body.locationId || req.query.locationId,
    });
    await safeAudit(req, {
      action: "campaign_created",
      entityType: "marketing_campaign",
      entityId: data.id,
      entityName: data.name,
      data,
      metadata: { campaignType: data.campaignType, status: data.status, templateId: data.templateId || null },
    });
    res.status(201).json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/campaigns/:id/preflight", async (req, res, next) => {
  try {
    const data = await service.preflightCampaignMessages(req.params.id, req.body || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/campaigns/:id/queue", async (req, res, next) => {
  try {
    const data = await service.queueCampaignMessages(req.params.id, req.body || {});
    await safeAudit(req, {
      action: "campaign_queued",
      entityType: "marketing_campaign",
      entityId: req.params.id,
      entityName: data.campaign?.name || null,
      data,
      metadata: {
        totalQueued: data.totalQueued,
        totalSuppressed: data.totalSuppressed,
        totalDuplicates: data.totalDuplicates,
        totalExisting: data.totalExisting,
        queueType: data.queueType,
        allowResend: data.allowResend,
      },
    });
    res.status(202).json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.get("/campaign-audience-jobs", async (req, res, next) => {
  try {
    const data = await service.listCampaignAudienceJobs(req.query || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.get("/campaign-audience-jobs/:id", async (req, res, next) => {
  try {
    const data = await service.getCampaignAudienceJob(req.params.id, req.query || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/campaigns/:id/pause", async (req, res, next) => {
  try {
    const data = await service.pauseCampaign(req.params.id, req.body || {});
    await safeAudit(req, {
      action: "campaign_paused",
      entityType: "marketing_campaign",
      entityId: req.params.id,
      entityName: data.campaign?.name || null,
      data,
      metadata: { reason: req.body?.reason || null },
    });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/campaigns/:id/resume", async (req, res, next) => {
  try {
    const data = await service.resumeCampaign(req.params.id, req.body || {});
    await safeAudit(req, {
      action: "campaign_resumed",
      entityType: "marketing_campaign",
      entityId: req.params.id,
      entityName: data.campaign?.name || null,
      data,
      metadata: { reason: req.body?.reason || null },
    });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/campaigns/:id/cancel", async (req, res, next) => {
  try {
    const data = await service.cancelCampaign(req.params.id, req.body || {});
    await safeAudit(req, {
      action: "campaign_cancelled",
      entityType: "marketing_campaign",
      entityId: req.params.id,
      entityName: data.campaign?.name || null,
      data,
      metadata: { reason: req.body?.reason || null, totalCancelled: data.totalCancelled || 0 },
    });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/messages/:id/retry", async (req, res, next) => {
  try {
    const data = await service.retryCampaignMessage(req.params.id, req.body || {});
    await safeAudit(req, {
      action: "message_retry_requested",
      entityType: "marketing_message",
      entityId: req.params.id,
      entityName: data.message?.recipient || null,
      data,
      metadata: { campaignId: data.message?.campaignId || null, queueType: data.queueType, retryCount: data.retryCount },
    });
    res.status(202).json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.patch("/campaigns/:id", async (req, res, next) => {
  try {
    const data = await service.updateCampaign(req.params.id, req.body);
    await safeAudit(req, {
      action: "campaign_updated",
      entityType: "marketing_campaign",
      entityId: data.id,
      entityName: data.name,
      data,
      metadata: { changedFields: Object.keys(req.body || {}), status: data.status },
    });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.delete("/campaigns/:id", async (req, res, next) => {
  try {
    const data = await service.deleteCampaign(req.params.id);
    await safeAudit(req, {
      action: "campaign_deleted",
      entityType: "marketing_campaign",
      entityId: req.params.id,
      entityName: data?.name || null,
      data,
      metadata: { status: data?.status || null, totalRecipients: data?.metrics?.recipients || 0 },
    });
    res.json({ success: true });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

// ── Suppressions ───────────────────────────────────────────────────

router.get("/suppressions", async (req, res, next) => {
  try {
    const data = await service.listSuppressions(req.query || {});
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.post("/suppressions", async (req, res, next) => {
  try {
    const data = await service.createSuppression({
      ...req.body,
      locationId: req.body.locationId || req.query.locationId,
    });
    await safeAudit(req, {
      action: "suppression_created",
      entityType: "marketing_suppression",
      entityId: data.id,
      entityName: data.email,
      data,
      metadata: { reason: data.reason, source: data.source, scope: data.scope },
    });
    res.status(201).json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

router.delete("/suppressions/:id", async (req, res, next) => {
  try {
    const data = await service.releaseSuppression(req.query.locationId, req.params.id);
    await safeAudit(req, {
      action: "suppression_released",
      entityType: "marketing_suppression",
      entityId: req.params.id,
      entityName: data?.email || null,
      data,
      metadata: { reason: data?.reason || null, source: data?.source || null },
    });
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

// ── Statistics ──────────────────────────────────────────────────────

router.get("/statistics", async (req, res, next) => {
  try {
    const data = await service.getStatistics(req.query);
    res.json({ success: true, data });
  } catch (err) {
    if (err.statusCode) return sendError(res, err);
    return next(err);
  }
});

module.exports = router;
