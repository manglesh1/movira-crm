require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const pinoHttp = require("pino-http");
const logger = require("./shared/logger");
const routes = require("./routes");
const corsOptions = require("./shared/corsOptions");
const triggerLinkService = require("./modules/marketing/triggerLinks/service");
const marketingTrackingRoutes = require("./modules/marketing/tracking/routes");
const transactionalTrackingRoutes = require("./modules/transactional/trackingRoutes");
const publicWebchatRoutes = require("./modules/conversations/publicWebchatRoutes");
const { startUnverifiedDomainCleaner } = require("./workers/unverifiedDomainCleaner");

const app = express();
const port = Number(process.env.PORT || 4100);


app.use(helmet());
app.use(express.json({
  limit: "2mb",
  verify: (req, _res, buf) => {
    req.rawBody = Buffer.from(buf);
  },
}));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(pinoHttp({ logger }));

// The website widget is intentionally public and applies its own per-widget
// origin allow-list. Mount it before the authenticated application's CORS
// policy, which only permits Movira admin origins.
app.use("/api/public/webchat", publicWebchatRoutes);
app.use(cors(corsOptions));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "movira-crm",
    domains: ["transactional", "marketing", "conversations"],
  });
});

// Public trigger-link redirect — recipients click /tl/:slug in emails,
// we record the click and 302 to the destination. Mounted before /api
// so it has no auth and stays cheap to hit.
app.get("/tl/:slug", async (req, res) => {
  try {
    const { destinationUrl } = await triggerLinkService.recordClick(req.params.slug);
    res.redirect(302, destinationUrl);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).send("Link not found");
    logger.error({ err, slug: req.params.slug }, "trigger link redirect failed");
    res.status(500).send("Could not redirect");
  }
});

app.use("/m", marketingTrackingRoutes);
app.use("/t", transactionalTrackingRoutes);

app.use("/api", routes);

app.use((err, _req, res, _next) => {
  logger.error({ err }, "Unhandled request error");
  res.status(500).json({ success: false, error: "Internal server error" });
});

app.listen(port, () => {
  logger.info({ port }, "movira-crm service started");
  startUnverifiedDomainCleaner();
});
