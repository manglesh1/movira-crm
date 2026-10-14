const test = require("node:test");
const assert = require("node:assert/strict");
const {
  _internal: { assertBindingScope, scopedBindingLocation },
} = require("../src/modules/notifications/service");

test("park user can manage a binding from the selected park", () => {
  const binding = { id: 1, locationId: 4 };
  assert.equal(
    assertBindingScope(binding, { locationId: 4, isSuperAdmin: false }),
    binding
  );
});

test("park user cannot manage another park or a global binding", () => {
  assert.throws(
    () =>
      assertBindingScope(
        { id: 2, locationId: 5 },
        { locationId: 4, isSuperAdmin: false }
      ),
    (error) =>
      error.statusCode === 403 &&
      error.code === "binding_location_access_denied"
  );
  assert.throws(
    () =>
      assertBindingScope(
        { id: 3, locationId: null },
        { locationId: 4, isSuperAdmin: false }
      ),
    (error) => error.statusCode === 403
  );
});

test("park user cannot see or manage Movira Control event bindings", () => {
  assert.throws(
    () =>
      assertBindingScope(
        { id: 9, locationId: 4, eventType: "saas.invoice.issued" },
        { locationId: 4, isSuperAdmin: false }
      ),
    (error) =>
      error.statusCode === 403 &&
      error.code === "movira_control_binding_access_denied"
  );
});

test("super admin can manage park and global bindings", () => {
  assert.doesNotThrow(() =>
    assertBindingScope(
      { id: 3, locationId: null },
      { locationId: 4, isSuperAdmin: true }
    )
  );
});

test("park user cannot create or move a binding outside the selected park", () => {
  assert.doesNotThrow(() =>
    scopedBindingLocation(
      { locationId: 4 },
      { locationId: 4, isSuperAdmin: false }
    )
  );
  assert.throws(
    () =>
      scopedBindingLocation(
        { locationId: 5 },
        { locationId: 4, isSuperAdmin: false }
      ),
    (error) =>
      error.statusCode === 403 &&
      error.code === "binding_location_access_denied"
  );
});
