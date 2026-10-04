const express = require("express");
const transactionalRoutes = require("../modules/transactional/routes");
const marketingRoutes = require("../modules/marketing/routes");
const webhookRoutes = require("../modules/webhooks/routes");
const settingsRoutes = require("../modules/settings/routes");
const notificationsRoutes = require("../modules/notifications/routes");
const contactRoutes = require("../modules/contacts/routes");
const contactFieldRoutes = require("../modules/contactFields/routes");
const segmentRoutes = require("../modules/segments/routes");
const automationRoutes = require("../modules/automation/routes");
const conversationRoutes = require("../modules/conversations/routes");

const router = express.Router();

router.use("/transactional", transactionalRoutes);
router.use("/marketing", marketingRoutes);
router.use("/settings", settingsRoutes);
router.use("/webhooks", webhookRoutes);
router.use("/notifications", notificationsRoutes);
router.use("/contacts", contactRoutes);
router.use("/contact-fields", contactFieldRoutes);
router.use("/segments", segmentRoutes);
router.use("/automation", automationRoutes);
router.use("/conversations", conversationRoutes);

module.exports = router;
