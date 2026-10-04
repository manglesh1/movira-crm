const test = require("node:test");
const assert = require("node:assert/strict");
const { engagementDetails, classifyClient, classifyDevice } = require("../src/modules/settings/email/analyticsService");

test("engagement analytics exposes unique link clicks and privacy-safe guidance", () => {
  const events = [
    { messageId: "m1", eventType: "click", payload: { destinationUrl: "https://example.com/a", userAgent: "Mozilla/5.0 (iPhone) AppleWebKit" } },
    { messageId: "m1", eventType: "click", payload: { destinationUrl: "https://example.com/a", userAgent: "Mozilla/5.0 (iPhone) AppleWebKit" } },
    { messageId: "m2", eventType: "clicked", payload: { destinationUrl: "https://example.com/a", userAgent: "Mozilla/5.0 Chrome/120", country: "CA" } },
  ];
  const result = engagementDetails(events);
  assert.deepEqual(result.links[0], { url: "https://example.com/a", uniqueClicks: 2, totalClicks: 3 });
  assert.equal(result.openMeasurement.quality, "estimated");
  assert.equal(result.devices.find((item) => item.label === "Mobile").count, 1);
  assert.equal(result.locations.find((item) => item.label === "CA").count, 1);
});

test("email clients and devices are derived without claiming unavailable geolocation", () => {
  assert.equal(classifyClient("GoogleImageProxy"), "Gmail image proxy");
  assert.equal(classifyDevice("Mozilla/5.0 (iPad)"), "Tablet");
  assert.equal(classifyDevice(""), "Unknown");
});
