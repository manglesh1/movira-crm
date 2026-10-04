const express = require("express");
const sesService = require("./sesService");
const providerEventsService = require("./providerEventsService");
const contactsService = require("../contacts/service");
const queueJobs = require("../queueJobs/service");
const { webhookAuth } = require("../../shared/webhookAuth");
const metaWebhookService = require("../conversations/metaWebhookService");
const config = require("../../config");
const crypto = require("crypto");
const emailIngestionService = require("../conversations/emailIngestionService");

const router = express.Router();

router.get("/meta", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = String(req.query["hub.verify_token"] || "");
  const expected = String(config.webhooks.metaVerifyToken || "");
  const tokenMatches = token.length === expected.length && token.length > 0 && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (mode === "subscribe" && tokenMatches) return res.status(200).send(String(req.query["hub.challenge"] || ""));
  return res.status(403).json({ success: false, error: "meta_webhook_verification_failed" });
});

router.post("/meta", webhookAuth("meta"), async (req, res, next) => {
  try {
    const data = await metaWebhookService.handleWebhook(req.body || {});
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

router.post("/ses", webhookAuth("ses"), async (req, res, next) => {
  try {
    const data = await sesService.handleSesWebhook(req.body || {});
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.post("/mailgun", webhookAuth("mailgun"), async (req, res, next) => {
  try {
    const data = await providerEventsService.handleMailgunWebhook(req.body || {});
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.post("/postmark", webhookAuth("postmark"), async (req, res, next) => {
  try {
    const data = await providerEventsService.handlePostmarkWebhook(req.body || {});
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.post("/sendgrid", webhookAuth("sendgrid"), async (req, res, next) => {
  try {
    const data = await providerEventsService.handleSendgridWebhook(req.body || {});
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.post("/movira/customer", webhookAuth("movira"), async (req, res, next) => {
  try {
    const data = await contactsService.processMoviraCustomerWebhook(req.body || {});
    const locationId = data.job?.locationId || req.body?.locationId || req.body?.location_id;
    data.automation = await queueJobs.enqueueAutomationEvents(data.automationEvents || [], {
      locationId,
      source: "movira_webhook",
    });
    data.segmentRefresh = await queueJobs.enqueueSegmentRefreshForLocation(locationId, {
      source: "movira_webhook",
      webhookRunId: data.job?.id,
    });
    res.status(202).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.post("/email/inbound", webhookAuth("movira"), async (req, res, next) => {
  try {
    const data = await emailIngestionService.ingest(req.body || {});
    res.status(data.duplicate ? 200 : 202).json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

router.post("/sms", (_req, res) => {
  res.status(501).json({
    success: false,
    error: "SMS status webhook ingestion is not implemented yet.",
  });
});

module.exports = router;
