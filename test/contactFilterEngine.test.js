const assert = require("node:assert/strict");
const test = require("node:test");
const { Op } = require("sequelize");
const engine = require("../src/modules/contacts/filterEngine");
const catalog = require("../src/modules/contacts/fieldCatalog");

const CUSTOM_FIELDS = [
  { key: "favourite_park", label: "Favourite park", fieldType: "dropdown", options: ["London", "Windsor"] },
  { key: "lifetime_spend", label: "Lifetime spend", fieldType: "currency" },
];

function symbols(obj) {
  return Object.getOwnPropertySymbols(obj || {});
}

test("empty / unknown filters compile to no constraint", () => {
  assert.deepEqual(engine.compile(null), {});
  assert.deepEqual(engine.compile({ match: "all", conditions: [] }), {});
  // unknown field is ignored, not crashed
  assert.deepEqual(engine.compile({ match: "all", conditions: [{ field: "nope", operator: "is", value: "x" }] }), {});
});

test("single condition compiles to a column fragment", () => {
  const where = engine.compile({ match: "all", conditions: [{ field: "email", operator: "contains", value: "gmail" }] });
  assert.ok(where.email, "email key present");
  assert.ok(symbols(where.email).includes(Op.iLike), "uses ILIKE");
  assert.equal(where.email[Op.iLike], "%gmail%");
});

test("multiple conditions group under the chosen combinator", () => {
  const all = engine.compile({
    match: "all",
    conditions: [
      { field: "lifecycle", operator: "is", value: "customer" },
      { field: "email", operator: "is_not_empty" },
    ],
  });
  assert.ok(symbols(all).includes(Op.and), "match all -> Op.and");

  const any = engine.compile({
    match: "any",
    conditions: [
      { field: "lifecycle", operator: "is", value: "customer" },
      { field: "lifecycle", operator: "is", value: "lead" },
    ],
  });
  assert.ok(symbols(any).includes(Op.or), "match any -> Op.or");
});

test("tags operators build containment fragments", () => {
  const hasAny = engine.compile({ match: "all", conditions: [{ field: "tags", operator: "has_any", value: ["a", "b"] }] });
  assert.ok(symbols(hasAny).includes(Op.or), "has_any is an OR of contains");

  const hasAll = engine.compile({ match: "all", conditions: [{ field: "tags", operator: "has_all", value: ["a", "b"] }] });
  assert.ok(hasAll.tags && symbols(hasAll.tags).includes(Op.contains), "has_all uses @>");

  const hasNone = engine.compile({ match: "all", conditions: [{ field: "tags", operator: "has_none", value: ["a"] }] });
  assert.ok(symbols(hasNone).includes(Op.not), "has_none wraps in NOT");
});

test("custom fields compile via JSONB literal (no crash, produces a fragment)", () => {
  const where = engine.compile(
    {
      match: "all",
      conditions: [
        { field: "cf:favourite_park", operator: "is", value: "London" },
        { field: "cf:lifetime_spend", operator: "gte", value: 100 },
      ],
    },
    { customFields: CUSTOM_FIELDS }
  );
  assert.ok(symbols(where).includes(Op.and));
  assert.equal(where[Op.and].length, 2);
});

test("custom field key is required to be present in catalog", () => {
  // Without the custom field definition, cf: condition is dropped.
  const where = engine.compile({ match: "all", conditions: [{ field: "cf:favourite_park", operator: "is", value: "London" }] });
  assert.deepEqual(where, {});
});

test("legacy fixed-shape filters convert to a tree with marketing defaults", () => {
  const tree = engine.normalize({ lifecycles: ["customer"], tagsAny: ["vip"] });
  assert.equal(tree.match, "all");
  const fieldsUsed = tree.conditions.flatMap((c) => (c.conditions ? c.conditions.map((x) => x.field) : [c.field]));
  assert.ok(fieldsUsed.includes("lifecycle"));
  assert.ok(fieldsUsed.includes("tags"));
  // subscribedOnly defaults on -> marketingStatus + doNotContact constraints added
  assert.ok(fieldsUsed.includes("marketingStatus"));
  assert.ok(fieldsUsed.includes("doNotContact"));
  // hasEmail defaults on -> email is_not_empty
  assert.ok(fieldsUsed.includes("email"));
});

test("isAdvancedTree distinguishes the two shapes", () => {
  assert.equal(engine.isAdvancedTree({ match: "all", conditions: [] }), true);
  assert.equal(engine.isAdvancedTree({ lifecycles: ["customer"] }), false);
});

test("analyze counts nested conditions for live-query guardrails", () => {
  const stats = engine.analyze({
    match: "all",
    conditions: [
      { field: "email", operator: "contains", value: "gmail" },
      {
        match: "any",
        conditions: [
          { field: "lifecycle", operator: "is", value: "customer" },
          { field: "tags", operator: "has_any", value: ["vip"] },
        ],
      },
    ],
  });
  assert.deepEqual(stats, { conditions: 3, depth: 1 });
});

test("searchFragment matches name / email / phone", () => {
  const frag = engine.searchFragment("ava");
  assert.ok(symbols(frag).includes(Op.or));
  assert.equal(frag[Op.or].length, 5);
  assert.equal(engine.searchFragment(""), null);
});

test("date catalog exposes practical operators by field role", () => {
  const built = catalog.buildCatalog([
    { key: "dateOfBirth", label: "Date of birth", fieldType: "date", isSystem: true },
    { key: "membershipExpiresAt", label: "Membership expires", fieldType: "date", isSystem: true },
    { key: "bookedActivities", label: "Activity name", fieldType: "text", isSystem: true },
  ], { dynamicOptions: { bookedActivities: ["Birthday Party", "Open Jump"] } });
  const created = built.builtin.find((field) => field.key === "createdAt");
  const dob = built.custom.find((field) => field.key === "cf:dateOfBirth");
  const expiry = built.custom.find((field) => field.key === "cf:membershipExpiresAt");
  const activities = built.custom.find((field) => field.key === "cf:bookedActivities");

  assert.ok(created.operators.includes("in_last"));
  assert.ok(!created.operators.includes("in_next"));
  assert.ok(dob.operators.includes("day_of_month"));
  assert.ok(dob.operators.includes("between_days_of_month"));
  assert.ok(expiry.operators.includes("in_next"));
  assert.ok(!expiry.operators.includes("more_than_ago"));
  assert.deepEqual(activities.operators, ["contains", "not_contains", "is_not_empty", "is_empty"]);
  assert.deepEqual(activities.options, ["Birthday Party", "Open Jump"]);
});

test("relative date operators compile against a stable clock", () => {
  const now = new Date(2026, 9, 1, 12, 0, 0);
  const today = engine.compile(
    { match: "all", conditions: [{ field: "createdAt", operator: "today" }] },
    { now }
  );
  assert.equal(today.createdAt[Op.gte].getHours(), 0);
  assert.equal(today.createdAt[Op.lt].getDate(), 2);

  const recent = engine.compile(
    { match: "all", conditions: [{ field: "updatedAt", operator: "in_last", value: { amount: 2, unit: "weeks" } }] },
    { now }
  );
  assert.equal(recent.updatedAt[Op.gte].getDate(), 17);
  assert.ok(recent.updatedAt[Op.lt] > now);
});

test("fixed date ranges include the full end date and after starts next day", () => {
  const range = engine.compile({
    match: "all",
    conditions: [{ field: "createdAt", operator: "between", value: ["2026-09-01", "2026-09-30"] }],
  });
  assert.equal(range.createdAt[Op.gte].getDate(), 1);
  assert.equal(range.createdAt[Op.lt].getDate(), 1);
  assert.equal(range.createdAt[Op.lt].getMonth(), 9);

  const after = engine.compile({
    match: "all",
    conditions: [{ field: "createdAt", operator: "after", value: "2026-09-30" }],
  });
  assert.equal(after.createdAt[Op.gte].getDate(), 1);
  assert.equal(after.createdAt[Op.gte].getMonth(), 9);
});

test('calendar date boundaries survive UTC, positive offsets and daylight-saving offsets', () => {
  const { spawnSync } = require('node:child_process');
  const script = `const e=require(${JSON.stringify(require.resolve('../src/modules/contacts/filterEngine'))});const {Op}=require('sequelize');
    const r=e.compile({conditions:[{field:'createdAt',operator:'on',value:'2026-03-08'}]});
    require('node:assert/strict').equal(r.createdAt[Op.gte].getDate(),8);
    require('node:assert/strict').equal(r.createdAt[Op.lt].getDate(),9);
    require('node:assert/strict').deepEqual(e.compile({conditions:[{field:'createdAt',operator:'on',value:'2026-02-30'}]}),{});`;
  for (const TZ of ['UTC','America/Halifax','America/Los_Angeles','Asia/Kolkata']) {
    const result=spawnSync(process.execPath,['-e',script],{env:{...process.env,TZ},encoding:'utf8'});
    assert.equal(result.status,0,`${TZ}: ${result.stderr}`);
  }
});

test("day-of-month and relative windows reject invalid values", () => {
  const customFields = [{ key: "dateOfBirth", label: "Date of birth", fieldType: "date" }];
  assert.deepEqual(
    engine.compile(
      { match: "all", conditions: [{ field: "cf:dateOfBirth", operator: "day_of_month", value: 32 }] },
      { customFields }
    ),
    {}
  );
  assert.deepEqual(
    engine.compile(
      { match: "all", conditions: [{ field: "createdAt", operator: "between_past", value: ["", 30] }] }
    ),
    {}
  );
});
