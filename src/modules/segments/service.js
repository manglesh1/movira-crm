const { Op } = require("sequelize");
const { getModels } = require("../../db/models");
const contactService = require("../contacts/service");
const filterEngine = require("../contacts/filterEngine");

const MAX_PREVIEW_CONDITIONS = 20;
const MAX_PREVIEW_DEPTH = 3;
const SEGMENT_REFRESH_BATCH_SIZE = 2000;

async function loadCustomFields(locationId) {
  const models = getModels();
  const fields = await models.CrmContactField.findAll({ where: { locationId, archivedAt: null } });
  return fields.map((row) => (row?.get ? row.get({ plain: true }) : row));
}

function badRequest(message, errors = []) {
  const err = new Error(message);
  err.statusCode = 400;
  err.errors = errors;
  return err;
}

function notFound(label) {
  const err = new Error(`${label} not found`);
  err.statusCode = 404;
  return err;
}

function requireLocation(locationId) {
  if (!locationId) throw badRequest("locationId is required");
  const value = Number(locationId);
  if (!Number.isInteger(value) || value <= 0) throw badRequest("locationId must be a positive integer");
  return value;
}

function cleanString(value, max = 240) {
  const text = String(value || "").trim();
  return text ? text.slice(0, max) : null;
}

function arrayOfStrings(value, maxItems = 20) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  return Array.from(new Set(list.map((item) => cleanString(item, 80)).filter(Boolean))).slice(0, maxItems);
}

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

function assertPreviewGuardrails(filters = {}) {
  const stats = filterEngine.analyze(filters || {});
  if (stats.conditions > MAX_PREVIEW_CONDITIONS) {
    throw badRequest(`Preview supports up to ${MAX_PREVIEW_CONDITIONS} conditions. Save as a segment to calculate larger filters in the queue.`);
  }
  if (stats.depth > MAX_PREVIEW_DEPTH) {
    throw badRequest(`Preview supports up to ${MAX_PREVIEW_DEPTH} nested levels. Save as a segment to calculate deeper filters in the queue.`);
  }
}

const STALE_SEGMENT_NAMES = new Set([
  "movira customers",
  "subscribed imported customers",
]);

function isMoviraCompatibleSegment(segment = {}) {
  if (STALE_SEGMENT_NAMES.has(String(segment.name || "").trim().toLowerCase())) {
    return false;
  }
  const filters = segment.filters || {};
  const sourceTypes = arrayOfStrings(filters.sourceTypes || filters.sourceType);
  return !sourceTypes.length || sourceTypes.includes("movira");
}

// Delegates to the shared advanced-filter engine. Accepts both the new
// condition-tree shape and the legacy fixed-filter shape. Returns a where
// scoped to the location.
function buildContactWhere(locationId, filters = {}, customFields = []) {
  const compiled = filterEngine.compile(filters, { customFields });
  return Object.keys(compiled).length ? { locationId, communicationOnly: false, [Op.and]: [compiled] } : { locationId, communicationOnly: false };
}

async function evaluateSegmentFilters({ locationId, filters = {}, page = 1, pageSize = 25 } = {}) {
  const models = getModels();
  const loc = requireLocation(locationId);
  const limit = Math.min(100, Math.max(1, Number(pageSize || 25)));
  const currentPage = Math.max(1, Number(page || 1));
  assertPreviewGuardrails(filters);
  const customFields = await loadCustomFields(loc);
  const where = buildContactWhere(loc, filters, customFields);
  const rows = await models.CrmContact.findAll({
    where,
    limit: limit + 1,
    offset: (currentPage - 1) * limit,
    order: [["updatedAt", "DESC"]],
  });
  const hasMore = rows.length > limit;
  return {
    items: rows.slice(0, limit).map(plain),
    total: null,
    hasMore,
    countMode: "skipped_for_preview",
    page: currentPage,
    pageSize: limit,
  };
}

async function refreshSegmentMembers(segment, transaction = null) {
  const models = getModels();
  const customFields = await loadCustomFields(segment.locationId);
  const existingMembers = await models.CrmSegmentMember.findAll({
    where: { segmentId: segment.id },
    attributes: ["contactId", "source"],
    transaction,
    raw: true,
  });
  const existingActiveIds = new Set(existingMembers.map((m) => m.contactId));
  const manualIds = new Set(existingMembers.filter((m) => m.source === "manual").map((m) => m.contactId));

  // Preserve manually-added members; only recompute filter-derived rows.
  await models.CrmSegmentMember.destroy({
    where: { segmentId: segment.id, source: "filter" },
    transaction,
  });

  const baseWhere = buildContactWhere(segment.locationId, segment.filters || {}, customFields);
  const enteredContactIds = [];
  let filterMemberCount = 0;
  let lastId = null;

  while (true) {
    const where = lastId ? { ...baseWhere, id: { [Op.gt]: lastId } } : baseWhere;
    const contactRows = await models.CrmContact.findAll({
      where,
      attributes: ["id"],
      limit: SEGMENT_REFRESH_BATCH_SIZE,
      order: [["id", "ASC"]],
      transaction,
      raw: true,
    });
    if (!contactRows.length) break;

    const contactIds = contactRows.map((row) => row.id);
    const filterIds = contactIds.filter((id) => !manualIds.has(id));
    if (filterIds.length) {
      filterMemberCount += filterIds.length;
      filterIds.forEach((id) => {
        if (!existingActiveIds.has(id)) enteredContactIds.push(id);
      });
      await models.CrmSegmentMember.bulkCreate(
        filterIds.map((contactId) => ({
          segmentId: segment.id,
          contactId,
          locationId: segment.locationId,
          source: "filter",
          status: "active",
          enteredAt: new Date(),
        })),
        { transaction }
      );
    }

    lastId = contactRows[contactRows.length - 1].id;
    if (contactRows.length < SEGMENT_REFRESH_BATCH_SIZE) break;
  }

  const updated = await segment.update(
    {
      memberCount: manualIds.size + filterMemberCount,
      lastCalculatedAt: new Date(),
    },
    { transaction }
  );
  await contactService.markContactFilterCountsStale(segment.locationId, "segment_members_refreshed");
  return { ...plain(updated), enteredContactIds };
}

async function listSegments(query = {}) {
  const models = getModels();
  const locationId = requireLocation(query.locationId);
  const where = { locationId };
  const q = cleanString(query.search, 120);
  if (query.status) where.status = cleanString(query.status, 40);
  if (q) where.name = { [Op.iLike]: `%${q}%` };
  const segments = await models.CrmSegment.findAll({
    where,
    order: [["updatedAt", "DESC"]],
    limit: Math.min(100, Math.max(1, Number(query.limit || 50))),
  });
  return segments.map(plain).filter(isMoviraCompatibleSegment);
}

async function getSegment(id, query = {}) {
  const models = getModels();
  const locationId = requireLocation(query.locationId);
  const segment = await models.CrmSegment.findOne({ where: { id, locationId } });
  if (!segment) throw notFound("Segment");
  return plain(segment);
}

async function createSegment(input = {}) {
  const models = getModels();
  const locationId = requireLocation(input.locationId);
  const name = cleanString(input.name, 180);
  if (!name) throw badRequest("Segment name is required");
  const filters = input.filters && typeof input.filters === "object" ? input.filters : {};

  const segment = await models.CrmSegment.create({
    locationId,
    name,
    description: cleanString(input.description, 2000),
    segmentType: cleanString(input.segmentType || "dynamic", 40) || "dynamic",
    status: cleanString(input.status || "active", 40) || "active",
    filters,
  });
  await contactService.markContactFilterCountsStale(locationId, "segment_created");
  return { ...plain(segment), refreshQueued: true };
}

async function updateSegment(id, input = {}) {
  const models = getModels();
  const locationId = requireLocation(input.locationId);
  const segment = await models.CrmSegment.findOne({ where: { id, locationId } });
  if (!segment) throw notFound("Segment");
  const patch = {};
  if (input.name !== undefined) patch.name = cleanString(input.name, 180);
  if (input.description !== undefined) patch.description = cleanString(input.description, 2000);
  if (input.status !== undefined) patch.status = cleanString(input.status, 40);
  if (input.segmentType !== undefined) patch.segmentType = cleanString(input.segmentType, 40);
  if (input.filters !== undefined) patch.filters = input.filters && typeof input.filters === "object" ? input.filters : {};

  const updated = await segment.update(patch);
  await contactService.markContactFilterCountsStale(locationId, "segment_updated");
  return { ...plain(updated), refreshQueued: input.filters !== undefined || input.refresh === true };
}

async function deleteSegment(id, query = {}) {
  const models = getModels();
  const locationId = requireLocation(query.locationId);
  const segment = await models.CrmSegment.findOne({ where: { id, locationId } });
  if (!segment) throw notFound("Segment");
  const data = plain(segment);
  await segment.destroy();
  await contactService.markContactFilterCountsStale(locationId, "segment_deleted");
  return data;
}

async function refreshSegment(id, query = {}) {
  const models = getModels();
  const locationId = requireLocation(query.locationId);
  const segment = await models.CrmSegment.findOne({ where: { id, locationId } });
  if (!segment) throw notFound("Segment");
  return refreshSegmentMembers(segment);
}

async function listSegmentContacts(id, query = {}) {
  const models = getModels();
  const locationId = requireLocation(query.locationId);
  const segment = await models.CrmSegment.findOne({ where: { id, locationId } });
  if (!segment) throw notFound("Segment");
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize || 25)));
  const result = await models.CrmSegmentMember.findAndCountAll({
    where: { segmentId: id, locationId, status: "active" },
    include: [{ model: models.CrmContact, as: "contact" }],
    limit: pageSize,
    offset: (page - 1) * pageSize,
    order: [["enteredAt", "DESC"]],
  });
  return {
    items: result.rows.map((row) => plain(row.contact)).filter(Boolean),
    total: result.count,
    page,
    pageSize,
  };
}

async function previewSegment(input = {}) {
  return evaluateSegmentFilters({
    locationId: input.locationId,
    filters: input.filters || {},
    page: input.page || 1,
    pageSize: input.pageSize || 25,
  });
}

async function getSegmentStats(query = {}) {
  const models = getModels();
  const locationId = requireLocation(query.locationId);
  const segments = await models.CrmSegment.findAll({
    where: { locationId },
    attributes: ["id", "status", "segmentType", "filters"],
  });
  const visibleSegments = segments.map(plain).filter(isMoviraCompatibleSegment);
  const visibleSegmentIds = visibleSegments.map((segment) => segment.id);
  const members = visibleSegmentIds.length
    ? await models.CrmSegmentMember.count({ where: { locationId, status: "active", segmentId: { [Op.in]: visibleSegmentIds } } })
    : 0;
  return {
    total: visibleSegments.length,
    active: visibleSegments.filter((segment) => segment.status === "active").length,
    dynamic: visibleSegments.filter((segment) => segment.segmentType === "dynamic").length,
    members,
  };
}

module.exports = {
  listSegments,
  getSegment,
  createSegment,
  updateSegment,
  deleteSegment,
  refreshSegment,
  listSegmentContacts,
  previewSegment,
  getSegmentStats,
  buildContactWhere,
};
