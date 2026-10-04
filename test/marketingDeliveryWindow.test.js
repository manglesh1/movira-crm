const test = require("node:test");
const assert = require("node:assert/strict");
const delivery = require("../src/modules/marketing/email/deliveryWindow");

test("delivery controls normalize customer batch pacing and weekdays", () => {
  const controls = delivery.normalizeDeliveryControls({
    batchSize: 25,
    batchIntervalMinutes: 15,
    deliveryWindow: { enabled: true, timezone: "Asia/Kolkata", weekdays: [1, "wed", 5], startTime: "09:00", endTime: "18:00" },
  });
  assert.equal(controls.batchSize, 25);
  assert.equal(controls.batchIntervalMinutes, 15);
  assert.deepEqual(controls.deliveryWindow.weekdays, [1, 3, 5]);
});

test("delivery window evaluates time in the customer timezone", () => {
  const window = { enabled: true, timezone: "Asia/Kolkata", weekdays: [1], startTime: "09:00", endTime: "18:00" };
  assert.equal(delivery.isWithinDeliveryWindow(new Date("2026-10-05T04:00:00.000Z"), window), true);
  assert.equal(delivery.isWithinDeliveryWindow(new Date("2026-10-05T15:00:00.000Z"), window), false);
});

test("next batch respects both interval and allowed delivery window", () => {
  const controls = delivery.normalizeDeliveryControls({
    batchIntervalMinutes: 60,
    deliveryWindow: { enabled: true, timezone: "UTC", weekdays: [1], startTime: "09:00", endTime: "10:00" },
  });
  const next = delivery.nextBatchAt(new Date("2026-10-05T09:30:00.000Z"), controls);
  assert.equal(next.toISOString(), "2026-10-12T09:00:00.000Z");
});
