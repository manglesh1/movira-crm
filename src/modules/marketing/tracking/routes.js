const express = require("express");
const service = require("./service");

const router = express.Router();

const PIXEL = Buffer.from(
  "R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==",
  "base64"
);

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

router.get("/open/:messageId.gif", async (req, res) => {
  try {
    await service.recordOpen(req, req.params.messageId);
  } catch (_err) {
    // Tracking pixels must never break the recipient experience.
  }
  res.set({
    "Content-Type": "image/gif",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Content-Length": PIXEL.length,
  });
  res.end(PIXEL);
});

router.get("/click/:messageId", async (req, res) => {
  const destinationUrl = req.query.u ? String(req.query.u) : "";
  if (!isHttpUrl(destinationUrl)) {
    return res.status(400).send("Invalid destination URL");
  }
  try {
    await service.recordClick(req, req.params.messageId, destinationUrl);
  } catch (_err) {
    // Still redirect; click tracking should degrade gracefully.
  }
  return res.redirect(302, destinationUrl);
});

async function unsubscribe(req, res, { oneClick = false } = {}) {
  try {
    await service.recordUnsubscribe(req, req.params.messageId, { oneClick });
    if (oneClick) return res.status(200).send("Unsubscribed");
    res.set("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Unsubscribed</title>
  </head>
  <body style="margin:0;font-family:Arial,sans-serif;background:#f8fafc;color:#111827;">
    <main style="max-width:520px;margin:12vh auto;padding:32px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;text-align:center;">
      <h1 style="font-size:24px;margin:0 0 12px;">You are unsubscribed</h1>
      <p style="font-size:15px;line-height:1.6;color:#4b5563;margin:0;">You will no longer receive marketing emails from this sender.</p>
    </main>
  </body>
</html>`);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).send("Message not found");
    return res.status(500).send("Could not unsubscribe");
  }
}

router.get("/unsubscribe/:messageId", (req, res) => unsubscribe(req, res));
router.post("/unsubscribe/:messageId", express.urlencoded({ extended: false }), (req, res) => {
  const oneClick = String(req.body?.["List-Unsubscribe"] || "").toLowerCase() === "one-click";
  if (!oneClick) return res.status(400).send("Invalid one-click unsubscribe request");
  return unsubscribe(req, res, { oneClick: true });
});

router.get("/view/:messageId", async (req, res) => {
  try {
    const rendered = await service.renderBrowserView(req.params.messageId);
    res.set("Content-Type", "text/html; charset=utf-8");
    return res.send(rendered.html);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).send("Message not found");
    return res.status(500).send("Could not render email");
  }
});

module.exports = router;
