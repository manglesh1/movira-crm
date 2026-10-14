const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isMoviraControlEvent,
  isMoviraControlMessage,
  isMoviraControlTemplate,
} = require("../src/shared/communicationScope");
const notificationService = require("../src/modules/notifications/service");
const {
  _internal: { assertTemplateAccess },
} = require("../src/modules/transactional/templateService");

test("Control scope recognises SaaS events, templates and messages", () => {
  assert.equal(isMoviraControlEvent("saas.invoice.issued"), true);
  assert.equal(isMoviraControlEvent("booking.confirmed"), false);
  assert.equal(isMoviraControlTemplate({ family: "saas" }), true);
  assert.equal(isMoviraControlTemplate({ config: { templateScope: "movira_control" } }), true);
  assert.equal(isMoviraControlTemplate({ family: "booking" }), false);
  assert.equal(isMoviraControlMessage({ sourceEventType: "saas.park.go_live", payload: {} }), true);
});

test("Control events and templates are visible only to Super Admin", () => {
  const regularEvents = notificationService.listEvents({ isSuperAdmin: false });
  const superEvents = notificationService.listEvents({ isSuperAdmin: true });
  assert.equal(regularEvents.some((event) => event.eventType.startsWith("saas.")), false);
  assert.equal(superEvents.some((event) => event.eventType.startsWith("saas.")), true);

  assert.throws(
    () => assertTemplateAccess({ family: "saas" }, { isSuperAdmin: false }),
    (error) => error.statusCode === 403
  );
  assert.doesNotThrow(() =>
    assertTemplateAccess({ family: "saas" }, { isSuperAdmin: true })
  );
});
