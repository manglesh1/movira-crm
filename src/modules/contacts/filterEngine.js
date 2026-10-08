// Advanced filter engine. Compiles an advanced condition tree into a
// Sequelize `where` fragment for crm_contacts. Shared by the customers grid
// search endpoint and the segment evaluator so a saved segment and an ad-hoc
// advanced filter behave identically.
//
// Canonical filter shape:
//   { match: "all" | "any", conditions: [ Condition | Group ] }
//   Condition = { field, operator, value }
//   Group     = { match, conditions: [...] }   // arbitrarily nested
//
// `field` is a catalog key. Built-in fields map to a crm_contacts column;
// custom fields use the "cf:<key>" prefix and live in the customFields JSONB.
//
// Legacy shape ({ sourceTypes, lifecycles, tagsAny, subscribedOnly, ... }) is
// auto-converted so segments saved by the old builder keep working.

const { Op, literal, where: sqlWhere } = require("sequelize");
const catalog = require("./fieldCatalog");

const VALID_KEY_RE = /^[A-Za-z0-9_]+$/;
const MAX_DEPTH = 6;

function escapeLike(value) {
  // Treat user input as literal text inside ILIKE patterns.
  return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}

function toArray(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  return list.map((item) => String(item).trim()).filter((item) => item.length > 0);
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayRange(value) {
  const date = parseDate(value);
  if (!date) return null;
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start, end];
}

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addCalendar(value, amount, unit = "days") {
  const date = new Date(value);
  if (unit === "months") date.setMonth(date.getMonth() + amount);
  else if (unit === "weeks") date.setDate(date.getDate() + amount * 7);
  else date.setDate(date.getDate() + amount);
  return date;
}

function positiveInteger(value, max = 100000) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= max ? number : null;
}

function relativeValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const amount = positiveInteger(value.amount);
    const unit = ["days", "weeks", "months"].includes(value.unit) ? value.unit : "days";
    return amount === null ? null : { amount, unit };
  }
  const amount = positiveInteger(value);
  return amount === null ? null : { amount, unit: "days" };
}

function rangeFragment(ref, from, to) {
  return ref.isCol
    ? { [ref.compare]: { [Op.gte]: from, [Op.lt]: to } }
    : { [Op.and]: [frag(ref, { [Op.gte]: from }), frag(ref, { [Op.lt]: to })] };
}

function dayOfMonthFragment(ref, value) {
  const day = positiveInteger(value, 31);
  if (day === null || day < 1) return null;
  return sqlWhere(literal(`EXTRACT(DAY FROM ${ref.compare})`), { [Op.eq]: day });
}

function betweenDaysOfMonthFragment(ref, value) {
  const from = positiveInteger(Array.isArray(value) ? value[0] : null, 31);
  const to = positiveInteger(Array.isArray(value) ? value[1] : null, 31);
  if (from === null || to === null || from < 1 || to < 1) return null;
  const expression = literal(`EXTRACT(DAY FROM ${ref.compare})`);
  if (from <= to) return sqlWhere(expression, { [Op.between]: [from, to] });
  return {
    [Op.or]: [
      sqlWhere(expression, { [Op.gte]: from }),
      sqlWhere(expression, { [Op.lte]: to }),
    ],
  };
}

// Build a lookup of catalog key -> resolved field descriptor. Built-in fields
// carry a column; custom fields carry a validated JSONB storage key + type.
function buildFieldMap(customFields = []) {
  const map = new Map();
  for (const field of catalog.BUILTIN_FIELDS) {
    map.set(field.key, { key: field.key, type: field.type, column: field.column });
  }
  for (const field of customFields) {
    const described = catalog.describeCustomField(field);
    if (!described.storageKey || !VALID_KEY_RE.test(described.storageKey)) continue;
    map.set(described.key, { key: described.key, type: described.type, storageKey: described.storageKey });
  }
  return map;
}

// A reference to the value being filtered: either a real column or a JSONB path.
function makeRef(def) {
  if (def.column) {
    return { isCol: true, compare: def.column, text: def.column };
  }
  const key = def.storageKey;
  const text = `("customFields"->>'${key}')`;
  let compare = text;
  if (def.type === "number" || def.type === "currency") compare = `${text}::numeric`;
  else if (def.type === "date") compare = `${text}::timestamptz`;
  else if (def.type === "boolean") compare = `${text}::boolean`;
  return { isCol: false, compare, text };
}

// Apply a Sequelize operator object to a reference (column or JSONB literal).
function frag(ref, opObj, useText = false) {
  const expr = useText ? ref.text : ref.compare;
  if (ref.isCol) return { [expr]: opObj };
  return sqlWhere(literal(expr), opObj);
}

function emptyFragment(ref, type) {
  const typedColumn = ref.isCol && ["number", "currency", "date", "boolean"].includes(type);
  if (typedColumn) return frag(ref, { [Op.is]: null });
  return { [Op.or]: [frag(ref, { [Op.is]: null }, true), frag(ref, { [Op.eq]: "" }, true)] };
}

function notEmptyFragment(ref, type) {
  const typedColumn = ref.isCol && ["number", "currency", "date", "boolean"].includes(type);
  if (typedColumn) return frag(ref, { [Op.ne]: null });
  return { [Op.and]: [frag(ref, { [Op.ne]: null }, true), frag(ref, { [Op.ne]: "" }, true)] };
}

function buildTagsCondition(operator, value) {
  const tags = toArray(value).map((t) => t.slice(0, 80));
  switch (operator) {
    case "has_any":
      if (!tags.length) return null;
      return { [Op.or]: tags.map((tag) => ({ tags: { [Op.contains]: [tag] } })) };
    case "has_all":
      if (!tags.length) return null;
      return { tags: { [Op.contains]: tags } };
    case "has_none":
      if (!tags.length) return null;
      return { [Op.not]: { [Op.or]: tags.map((tag) => ({ tags: { [Op.contains]: [tag] } })) } };
    case "is_empty":
      return { [Op.or]: [{ tags: { [Op.is]: null } }, sqlWhere(literal('jsonb_array_length("tags")'), { [Op.eq]: 0 })] };
    case "is_not_empty":
      return sqlWhere(literal('jsonb_array_length("tags")'), { [Op.gt]: 0 });
    default:
      return null;
  }
}

function buildCondition(condition, fieldMap, now = new Date()) {
  if (!condition || typeof condition !== "object") return null;
  const def = fieldMap.get(condition.field);
  if (!def) return null;
  const operator = String(condition.operator || "").trim();
  const type = def.type;
  const value = condition.value;

  if (type === "tags") return buildTagsCondition(operator, value);

  const ref = makeRef(def);
  if (operator === "is_empty") return emptyFragment(ref, type);
  if (operator === "is_not_empty") return notEmptyFragment(ref, type);
  if (operator === "is_true") return frag(ref, { [Op.eq]: true });
  if (operator === "is_false") return frag(ref, { [Op.eq]: false });

  if (type === "boolean") return null; // booleans only use is_true / is_false

  if (type === "date") {
    if (operator === "on") {
      const range = dayRange(value);
      if (!range) return null;
      return ref.isCol
        ? { [ref.compare]: { [Op.gte]: range[0], [Op.lt]: range[1] } }
        : { [Op.and]: [frag(ref, { [Op.gte]: range[0] }), frag(ref, { [Op.lt]: range[1] })] };
    }
    if (operator === "before") {
      const date = parseDate(value);
      return date ? frag(ref, { [Op.lt]: date }) : null;
    }
    if (operator === "after") {
      const date = parseDate(value);
      return date ? frag(ref, { [Op.gte]: addCalendar(startOfDay(date), 1) }) : null;
    }
    if (operator === "between") {
      const from = parseDate(Array.isArray(value) ? value[0] : value);
      const to = parseDate(Array.isArray(value) ? value[1] : condition.valueTo);
      if (!from || !to) return null;
      const start = startOfDay(from);
      const end = addCalendar(startOfDay(to), 1);
      return start < end ? rangeFragment(ref, start, end) : null;
    }
    if (operator === "today") return rangeFragment(ref, startOfDay(now), addCalendar(startOfDay(now), 1));
    if (operator === "yesterday") {
      const end = startOfDay(now);
      return rangeFragment(ref, addCalendar(end, -1), end);
    }
    if (operator === "day_of_month") return dayOfMonthFragment(ref, value);
    if (operator === "between_days_of_month") return betweenDaysOfMonthFragment(ref, value);
    if (operator === "in_last" || operator === "in_next") {
      const relative = relativeValue(value);
      if (!relative) return null;
      const anchor = new Date(now);
      const edge = addCalendar(anchor, operator === "in_last" ? -relative.amount : relative.amount, relative.unit);
      return operator === "in_last"
        ? rangeFragment(ref, edge, new Date(anchor.getTime() + 1))
        : rangeFragment(ref, anchor, new Date(edge.getTime() + 1));
    }
    if (["more_than_ago", "days_ago", "weeks_ago", "months_ago"].includes(operator)) {
      const amount = positiveInteger(value);
      if (amount === null) return null;
      const unit = operator === "weeks_ago" ? "weeks" : operator === "months_ago" ? "months" : "days";
      const target = startOfDay(addCalendar(now, -amount, unit));
      if (operator === "more_than_ago") return frag(ref, { [Op.lt]: target });
      return rangeFragment(ref, target, addCalendar(target, 1));
    }
    if (operator === "between_past" || operator === "between_future") {
      const first = positiveInteger(Array.isArray(value) ? value[0] : null);
      const second = positiveInteger(Array.isArray(value) ? value[1] : null);
      if (first === null || second === null) return null;
      const low = Math.min(first, second);
      const high = Math.max(first, second);
      if (operator === "between_past") {
        const from = startOfDay(addCalendar(now, -high));
        const to = addCalendar(startOfDay(addCalendar(now, -low)), 1);
        return rangeFragment(ref, from, to);
      }
      const from = startOfDay(addCalendar(now, low));
      const to = addCalendar(startOfDay(addCalendar(now, high)), 1);
      return rangeFragment(ref, from, to);
    }
    return null;
  }

  if (type === "number" || type === "currency") {
    if (operator === "between") {
      const from = toNumber(Array.isArray(value) ? value[0] : value);
      const to = toNumber(Array.isArray(value) ? value[1] : condition.valueTo);
      if (from === null || to === null) return null;
      return ref.isCol
        ? { [ref.compare]: { [Op.between]: [from, to] } }
        : { [Op.and]: [frag(ref, { [Op.gte]: from }), frag(ref, { [Op.lte]: to })] };
    }
    const num = toNumber(value);
    if (num === null) return null;
    const map = { eq: Op.eq, neq: Op.ne, gt: Op.gt, gte: Op.gte, lt: Op.lt, lte: Op.lte };
    const op = map[operator];
    return op ? frag(ref, { [op]: num }) : null;
  }

  if (type === "enum") {
    if (operator === "is_one_of") {
      const list = toArray(value);
      return list.length ? frag(ref, { [Op.in]: list }) : null;
    }
    const text = String(value ?? "").trim();
    if (!text) return null;
    if (operator === "is") return frag(ref, { [Op.eq]: text });
    if (operator === "is_not") return frag(ref, { [Op.ne]: text });
    return null;
  }

  // string-like
  const text = String(value ?? "").trim();
  if (!text) return null;
  const esc = escapeLike(text.slice(0, 240));
  switch (operator) {
    case "contains":
      return frag(ref, { [Op.iLike]: `%${esc}%` });
    case "not_contains":
      return frag(ref, { [Op.notILike]: `%${esc}%` });
    case "is":
      return frag(ref, { [Op.iLike]: esc });
    case "is_not":
      return frag(ref, { [Op.notILike]: esc });
    case "starts_with":
      return frag(ref, { [Op.iLike]: `${esc}%` });
    case "ends_with":
      return frag(ref, { [Op.iLike]: `%${esc}` });
    default:
      return null;
  }
}

function buildGroup(group, fieldMap, depth, now) {
  if (depth > MAX_DEPTH) return null;
  const conditions = Array.isArray(group.conditions) ? group.conditions : [];
  const combinator = group.match === "any" ? Op.or : Op.and;
  const compiled = conditions
    .map((entry) =>
      Array.isArray(entry?.conditions)
        ? buildGroup(entry, fieldMap, depth + 1, now)
        : buildCondition(entry, fieldMap, now)
    )
    .filter(Boolean);
  if (!compiled.length) return null;
  if (compiled.length === 1) return compiled[0];
  return { [combinator]: compiled };
}

// ---- Legacy adapter -------------------------------------------------------

function convertLegacy(filters = {}) {
  const conditions = [];
  const sourceTypes = toArray(filters.sourceTypes || filters.sourceType);
  const lifecycles = toArray(filters.lifecycles || filters.lifecycle);
  const marketingStatuses = toArray(filters.marketingStatuses || filters.marketingStatus);
  const tagsAny = toArray(filters.tagsAny);
  const tagsAll = toArray(filters.tagsAll || filters.tags);

  if (filters.includeAllSources === true) {
    if (sourceTypes.length) conditions.push({ field: "sourceType", operator: "is_one_of", value: sourceTypes });
  } else {
    conditions.push({ field: "sourceType", operator: "is_one_of", value: sourceTypes.length ? sourceTypes : ["movira"] });
  }
  if (lifecycles.length) conditions.push({ field: "lifecycle", operator: "is_one_of", value: lifecycles });
  if (marketingStatuses.length) conditions.push({ field: "marketingStatus", operator: "is_one_of", value: marketingStatuses });
  if (tagsAll.length) conditions.push({ field: "tags", operator: "has_all", value: tagsAll });
  if (tagsAny.length) conditions.push({ field: "tags", operator: "has_any", value: tagsAny });

  if (filters.doNotContact === true) conditions.push({ field: "doNotContact", operator: "is_true" });
  else if (filters.doNotContact === false) conditions.push({ field: "doNotContact", operator: "is_false" });

  if (filters.subscribedOnly !== false) {
    conditions.push({ field: "marketingStatus", operator: "is", value: "subscribed" });
    conditions.push({ field: "doNotContact", operator: "is_false" });
  }
  if (filters.hasEmail !== false) {
    conditions.push({ field: "email", operator: "is_not_empty" });
  }
  if (filters.search) {
    conditions.push({
      match: "any",
      conditions: [
        { field: "fullName", operator: "contains", value: filters.search },
        { field: "email", operator: "contains", value: filters.search },
        { field: "phone", operator: "contains", value: filters.search },
      ],
    });
  }
  return { match: "all", conditions };
}

function normalize(filters) {
  if (!filters || typeof filters !== "object") return { match: "all", conditions: [] };
  if (Array.isArray(filters.conditions)) {
    return { match: filters.match === "any" ? "any" : "all", conditions: filters.conditions };
  }
  return convertLegacy(filters);
}

function isAdvancedTree(filters) {
  return Boolean(filters && typeof filters === "object" && Array.isArray(filters.conditions));
}

function analyzeGroup(group, depth = 0) {
  if (!group || typeof group !== "object") return { conditions: 0, depth };
  const entries = Array.isArray(group.conditions) ? group.conditions : [];
  return entries.reduce(
    (acc, entry) => {
      if (Array.isArray(entry?.conditions)) {
        const nested = analyzeGroup(entry, depth + 1);
        return {
          conditions: acc.conditions + nested.conditions,
          depth: Math.max(acc.depth, nested.depth),
        };
      }
      return { conditions: acc.conditions + 1, depth: acc.depth };
    },
    { conditions: 0, depth }
  );
}

function analyze(filters) {
  return analyzeGroup(normalize(filters), 0);
}

// Compile a filter (tree or legacy) to a Sequelize where fragment.
// Returns {} when there is nothing to constrain.
function compile(filters, { customFields = [], now = new Date() } = {}) {
  const fieldMap = buildFieldMap(customFields);
  const tree = normalize(filters);
  const where = buildGroup(tree, fieldMap, 0, now);
  return where || {};
}

// Free-text search across name/email/phone, used by the grid search box.
function searchFragment(term) {
  const text = String(term || "").trim();
  if (!text) return null;
  const esc = `%${escapeLike(text.slice(0, 120))}%`;
  const phoneDigits = text.replace(/\D/g, "");
  return {
    [Op.or]: [
      { fullName: { [Op.iLike]: esc } },
      { firstName: { [Op.iLike]: esc } },
      { lastName: { [Op.iLike]: esc } },
      { email: { [Op.iLike]: esc } },
      { phone: { [Op.iLike]: esc } },
      ...(phoneDigits.length >= 3 ? [{ normalizedPhone: { [Op.iLike]: `%${escapeLike(phoneDigits)}%` } }] : []),
    ],
  };
}

module.exports = {
  compile,
  buildFieldMap,
  searchFragment,
  normalize,
  analyze,
  convertLegacy,
  isAdvancedTree,
};
