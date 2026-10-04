const test = require("node:test");
const assert = require("node:assert/strict");
const { assertLocationOwnership } = require("../src/modules/settings/email/service");

test("email settings resources cannot be operated through another location context", () => {
  assert.equal(assertLocationOwnership({ locationId: 12 }, 12).locationId, 12);
  assert.throws(
    () => assertLocationOwnership({ locationId: 12 }, 99, "Provider"),
    (error) => error.statusCode === 404 && error.code === "LOCATION_RESOURCE_NOT_FOUND"
  );
});
