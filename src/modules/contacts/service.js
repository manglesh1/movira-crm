const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Op } = require("sequelize");
const { getModels } = require("../../db/models");
const queueJobs = require("../queueJobs/service");
const contactFieldService = require("../contactFields/service");
const exportStorage = require("./exportStorage");
const filterEngine = require("./filterEngine");
const catalog = require("./fieldCatalog");
const { normalizePhoneNumber } = require("../../utils/phoneNumber");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_SOURCE_TYPES = new Set(["movira", "csv", "manual", "form", "api", "webhook", "imported"]);
const VALID_MARKETING_STATUSES = new Set(["subscribed", "unsubscribed", "bounced", "complained", "unknown"]);
const VALID_LIFECYCLES = new Set(["lead", "customer", "member", "guest", "prospect", "inactive", "vip"]);
const MAX_LIVE_FILTER_CONDITIONS = 20;
const MAX_LIVE_FILTER_DEPTH = 3;
const FILTER_COUNT_STALE_MS = 5 * 60 * 1000;
const BULK_ACTION_DIRECT_LIMIT = 1000;
const BULK_ACTION_BATCH_SIZE = 1000;
const EXPORT_DIRECT_LIMIT = 5000;
const EXPORT_DIR = process.env.CRM_CONTACT_EXPORT_DIR || path.join(os.tmpdir(), "movira-crm-exports");

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

function normalizeEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  return value || null;
}

function normalizePhone(phone, locationCountry) {
  return normalizePhoneNumber(phone, locationCountry);
}

function cleanString(value, max = 240) {
  const text = String(value || "").trim();
  return text ? text.slice(0, max) : null;
}

function splitName(input) {
  const fullName = cleanString(input.fullName || input.name || [input.firstName, input.lastName].filter(Boolean).join(" "));
  const firstName = cleanString(input.firstName, 120);
  const lastName = cleanString(input.lastName, 120);
  if (firstName || lastName || !fullName) return { fullName, firstName, lastName };
  const parts = fullName.split(/\s+/);
  return {
    fullName,
    firstName: parts[0] || null,
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
  };
}

function normalizeTags(tags) {
  const list = Array.isArray(tags)
    ? tags
    : String(tags || "")
      .split(",")
      .map((item) => item.trim());
  return Array.from(new Set(list.map((item) => cleanString(item, 80)).filter(Boolean)));
}

function normalizeTagName(tag) {
  return cleanString(tag, 80);
}

function tagKey(tag) {
  return String(tag || "").trim().toLowerCase();
}

function cleanColor(value) {
  const color = cleanString(value, 20);
  if (!color) return null;
  return /^#[0-9a-f]{6}$/i.test(color) ? color : null;
}

function mergeTags(existing = [], incoming = []) {
  const next = [];
  [...normalizeTags(existing), ...normalizeTags(incoming)].forEach((tag) => {
    if (!next.some((item) => tagKey(item) === tagKey(tag))) next.push(tag);
  });
  return next;
}

function diffTags(before = [], after = []) {
  const beforeSet = new Set(normalizeTags(before).map(tagKey));
  const afterList = normalizeTags(after);
  return afterList.filter((tag) => !beforeSet.has(tagKey(tag)));
}

async function ensureContactTags(models, locationId, tags, transaction) {
  for (const tag of normalizeTags(tags)) {
    const name = normalizeTagName(tag);
    if (!name) continue;
    await models.CrmContactTag.findOrCreate({
      where: { locationId, normalizedName: tagKey(name) },
      defaults: { locationId, name, normalizedName: tagKey(name) },
      transaction,
    });
  }
}

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

function hasFilterConditions(filters) {
  return filterEngine.analyze(filters || {}).conditions > 0;
}

function assertLiveFilterGuardrails(filters = {}) {
  const stats = filterEngine.analyze(filters || {});
  if (stats.conditions > MAX_LIVE_FILTER_CONDITIONS) {
    throw badRequest(`Live advanced filters support up to ${MAX_LIVE_FILTER_CONDITIONS} conditions. Save this filter as a segment for queued calculation.`);
  }
  if (stats.depth > MAX_LIVE_FILTER_DEPTH) {
    throw badRequest(`Live advanced filters support up to ${MAX_LIVE_FILTER_DEPTH} nested levels. Save this filter as a segment for queued calculation.`);
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function contactFilterScope(input = {}, locationId) {
  return {
    locationId,
    segmentId: cleanString(input.segmentId, 80),
    filters: input.filters && typeof input.filters === "object" ? filterEngine.normalize(input.filters) : null,
    search: cleanString(input.search, 120),
  };
}

function contactFilterScopeHash(scope) {
  return crypto.createHash("sha256").update(stableStringify(scope)).digest("hex");
}

function filterCountSnapshot(row, queued = false) {
  const data = plain(row);
  if (!data) return null;
  return {
    id: data.id,
    scopeHash: data.scopeHash,
    status: data.status,
    total: data.total,
    calculatedAt: data.calculatedAt,
    lastError: data.lastError,
    queued,
    mode: "async_filter_count",
  };
}

function isFilterCountStale(row) {
  if (row?.invalidatedAt && (!row.calculatedAt || new Date(row.invalidatedAt).getTime() > new Date(row.calculatedAt).getTime())) return true;
  if (!row?.calculatedAt) return true;
  return Date.now() - new Date(row.calculatedAt).getTime() > FILTER_COUNT_STALE_MS;
}

async function markContactFilterCountsStale(locationId, reason = "contacts_changed") {
  const models = getModels();
  const loc = requireLocation(locationId);
  await models.CrmContactFilterCount.update(
    {
      status: "stale",
      calculatedAt: null,
      invalidatedAt: new Date(),
      lastError: reason,
    },
    {
      where: {
        locationId: loc,
        status: { [Op.in]: ["completed", "failed", "pending", "processing"] },
      },
    }
  );
}

function contactPayload(input = {}, locationId) {
  const names = splitName(input);
  const email = cleanString(input.email || input.guestEmail, 320);
  const normalizedEmail = normalizeEmail(email);
  const rawPhone = cleanString(input.phone || input.guestPhone, 60);
  const locationCountry = input.locationCountry || input.sourceSnapshot?.locationCountry || input.country;
  const normalizedPhone = normalizePhone(rawPhone, locationCountry);
  if (rawPhone && !normalizedPhone) throw badRequest(`Enter a valid phone number for the ${locationCountry || "selected location"}.`);
  const phone = normalizedPhone;
  const sourceType = cleanString(input.sourceType || input.source || "manual", 40) || "manual";
  const lifecycle = cleanString(input.lifecycle || input.type || "lead", 40) || "lead";
  const marketingStatus = cleanString(input.marketingStatus || "subscribed", 40) || "subscribed";

  if (!normalizedEmail) {
    throw badRequest("Contact email is required");
  }
  if (!EMAIL_RE.test(normalizedEmail)) {
    throw badRequest("Valid email is required");
  }
  if (!VALID_SOURCE_TYPES.has(sourceType)) {
    throw badRequest(`Unsupported sourceType: ${sourceType}`);
  }
  if (!VALID_LIFECYCLES.has(lifecycle)) {
    throw badRequest(`Unsupported lifecycle: ${lifecycle}`);
  }
  if (!VALID_MARKETING_STATUSES.has(marketingStatus)) {
    throw badRequest(`Unsupported marketingStatus: ${marketingStatus}`);
  }

  return {
    locationId,
    ...names,
    email,
    normalizedEmail,
    phone,
    normalizedPhone,
    sourceType,
    sourceRefType: cleanString(input.sourceRefType || input.externalType, 80),
    sourceRefId: cleanString(input.sourceRefId || input.externalId, 120),
    lifecycle,
    marketingStatus,
    smsStatus: cleanString(input.smsStatus || "unknown", 40) || "unknown",
    doNotContact: Boolean(input.doNotContact),
    tags: normalizeTags(input.tags),
    customFields: input.customFields && typeof input.customFields === "object" ? input.customFields : {},
    sourceSnapshot: input.sourceSnapshot && typeof input.sourceSnapshot === "object" ? input.sourceSnapshot : {},
    lastEngagedAt: input.lastEngagedAt || null,
  };
}

function identityPayload(input = {}, contact, locationId) {
  const externalType = cleanString(input.externalType || input.sourceRefType, 80);
  const externalId = cleanString(input.externalId || input.sourceRefId, 160);
  if (!externalType || !externalId) return null;
  return {
    contactId: contact.id,
    locationId,
    provider: cleanString(input.provider || input.identityProvider || input.sourceType || "movira", 40) || "movira",
    externalType,
    externalId,
    metadata: input.identityMetadata && typeof input.identityMetadata === "object" ? input.identityMetadata : {},
  };
}

async function findExistingContact(models, payload, identity, transaction) {
  if (identity) {
    const existingIdentity = await models.CrmContactIdentity.findOne({
      where: {
        locationId: identity.locationId,
        provider: identity.provider,
        externalType: identity.externalType,
        externalId: identity.externalId,
      },
      include: [{ model: models.CrmContact, as: "contact" }],
      transaction,
    });
    if (existingIdentity?.contact) return existingIdentity.contact;
  }

  if (payload.normalizedEmail) {
    const byEmail = await models.CrmContact.findOne({
      where: { locationId: payload.locationId, normalizedEmail: payload.normalizedEmail },
      transaction,
    });
    if (byEmail) return byEmail;
  }

  if (payload.normalizedPhone) {
    return models.CrmContact.findOne({
      where: { locationId: payload.locationId, normalizedPhone: payload.normalizedPhone },
      transaction,
    });
  }
  return null;
}

async function upsertContact(input = {}) {
  const models = getModels();
  const locationId = requireLocation(input.locationId);
  const payload = contactPayload(input, locationId);
  const provisionalIdentity = identityPayload(input, { id: null }, locationId);

  const result = await models.sequelize.transaction(async (transaction) => {
    const existing = await findExistingContact(models, payload, provisionalIdentity, transaction);
    let contact;
    let created = false;
    let previousTags = [];
    if (existing) {
      previousTags = normalizeTags(existing.tags);
      const next = {
        ...payload,
        fullName: payload.fullName || existing.fullName,
        firstName: payload.firstName || existing.firstName,
        lastName: payload.lastName || existing.lastName,
        email: payload.email || existing.email,
        normalizedEmail: payload.normalizedEmail || existing.normalizedEmail,
        phone: payload.phone || existing.phone,
        normalizedPhone: payload.normalizedPhone || existing.normalizedPhone,
        tags: mergeTags(existing.tags, payload.tags),
        customFields: { ...(existing.customFields || {}), ...(payload.customFields || {}) },
        sourceSnapshot: { ...(existing.sourceSnapshot || {}), ...(payload.sourceSnapshot || {}) },
        doNotContact: Boolean(existing.doNotContact || payload.doNotContact),
      };
      contact = await existing.update(next, { transaction });
    } else {
      contact = await models.CrmContact.create(payload, { transaction });
      created = true;
    }

    const identity = identityPayload(input, contact, locationId);
    if (identity) {
      await models.CrmContactIdentity.findOrCreate({
        where: {
          locationId,
          provider: identity.provider,
          externalType: identity.externalType,
          externalId: identity.externalId,
        },
        defaults: identity,
        transaction,
      });
    }

    const contactData = plain(contact);
    return { contact: contactData, created, tagsAdded: created ? normalizeTags(contactData.tags) : diffTags(previousTags, contactData.tags) };
  });
  if (!input.skipFilterCountInvalidation) {
    await markContactFilterCountsStale(locationId, result.created ? "contact_created" : "contact_upserted");
  }
  return result;
}

async function listContacts(query = {}) {
  const models = getModels();
  const locationId = requireLocation(query.locationId);
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize || 25)));
  const where = { locationId };
  const q = cleanString(query.search, 120);

  if (query.sourceType) where.sourceType = cleanString(query.sourceType, 40);
  if (query.marketingStatus) where.marketingStatus = cleanString(query.marketingStatus, 40);
  if (q) {
    const phoneDigits = q.replace(/\D/g, "");
    where[Op.or] = [
      { fullName: { [Op.iLike]: `%${q}%` } },
      { email: { [Op.iLike]: `%${q}%` } },
      { phone: { [Op.iLike]: `%${q}%` } },
      ...(phoneDigits.length >= 3 ? [{ normalizedPhone: { [Op.iLike]: `%${phoneDigits}%` } }] : []),
    ];
  }

  const result = await models.CrmContact.findAndCountAll({
    where,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    order: [["updatedAt", "DESC"]],
  });

  return {
    items: result.rows.map(plain),
    page,
    pageSize,
    total: result.count,
  };
}

async function getContact(id, query = {}) {
  const models = getModels();
  const locationId = requireLocation(query.locationId);
  const contact = await models.CrmContact.findOne({
    where: { id, locationId },
    include: [{ model: models.CrmContactIdentity, as: "identities" }],
  });
  if (!contact) throw notFound("Contact");
  return plain(contact);
}

async function updateContact(id, input = {}) {
  const models = getModels();
  const locationId = requireLocation(input.locationId);
  const contact = await models.CrmContact.findOne({ where: { id, locationId } });
  if (!contact) throw notFound("Contact");
  const previousTags = normalizeTags(contact.tags);
  const payload = contactPayload({ ...plain(contact), ...input }, locationId);
  const updated = await contact.update({
    ...payload,
    tags: normalizeTags(input.tags ?? contact.tags),
    customFields: input.customFields && typeof input.customFields === "object"
      ? { ...(contact.customFields || {}), ...input.customFields }
      : contact.customFields,
    sourceSnapshot: input.sourceSnapshot && typeof input.sourceSnapshot === "object"
      ? { ...(contact.sourceSnapshot || {}), ...input.sourceSnapshot }
      : contact.sourceSnapshot,
  });
  const data = plain(updated);
  await markContactFilterCountsStale(locationId, "contact_updated");
  return { ...data, tagsAdded: diffTags(previousTags, data.tags) };
}

function mapCoreCustomerToContact(customer = {}, defaults = {}) {
  const rawTags = Array.isArray(customer.tags) ? customer.tags : [];
  const tags = new Set(rawTags.filter(Boolean));
  if (customer.waiverStatus && customer.waiverStatus !== "none") tags.add(`waiver:${customer.waiverStatus}`);
  if (Number(customer.bookingCount || 0) > 0) tags.add("booking-customer");
  if (Number(customer.visitCount || 0) > 0) tags.add("visited");

  return {
    ...defaults,
    fullName: customer.name || customer.guestName || customer.fullName,
    firstName: customer.firstName,
    lastName: customer.lastName,
    email: customer.email,
    phone: customer.phone,
    sourceType: "movira",
    sourceRefType: "guest",
    sourceRefId: String(customer.id || customer.guestId || ""),
    externalType: "guest",
    externalId: String(customer.id || customer.guestId || ""),
    lifecycle: customer.lifecycle || (Number(customer.bookingCount || 0) > 0 ? "customer" : "lead"),
    marketingStatus: customer.doNotContact ? "unsubscribed" : "subscribed",
    doNotContact: Boolean(customer.doNotContact),
    provider: "movira",
    tags: Array.from(tags),
    customFields: {
      address: customer.address || null,
      postcode: customer.postcode || null,
      gender: customer.gender || null,
      locationId: Number(customer.locationId || defaults.locationId || 0) || null,
      locationName: customer.locationName || customer.location?.legalBusinessName || customer.location?.name || customer.venueName || customer.locationSlug || (customer.locationId || defaults.locationId ? `Location ${customer.locationId || defaults.locationId}` : null),
      locationSlug: customer.locationSlug || customer.location?.slug || null,
      locationAddress: customer.locationAddress || customer.location?.displayAddress || null,
      source: customer.source || "booking",
      dateOfBirth: customer.dateOfBirth || customer.dob || customer.guestDateOfBirth || null,
      bookingCount: Number(customer.bookingCount || 0),
      totalSpend: Number(customer.totalSpend || 0),
      totalDiscount: Number(customer.totalDiscount || 0),
      totalOutstandingBalance: Number(customer.totalOutstandingBalance || 0),
      visitCount: Number(customer.visitCount || 0),
      lastVisit: customer.lastVisit || null,
      lastBookingDate: customer.lastBookingDate || customer.lastVisit || null,
      lastBookingId: customer.lastBookingId || null,
      lastBookingNumber: customer.lastBookingNumber || null,
      lastBookingStatus: customer.lastBookingStatus || null,
      lastBookingPaymentStatus: customer.lastBookingPaymentStatus || null,
      lastBookingActivity: customer.lastBookingActivity || null,
      bookedActivities: Array.isArray(customer.activityNames)
        ? customer.activityNames.map((name) => String(name || "").trim()).filter(Boolean).join(", ")
        : String(customer.bookedActivities || "").trim() || null,
      lastBookingActivityDate: customer.lastBookingActivityDate || null,
      lastBookingActivityDateEnd: customer.lastBookingActivityDateEnd || null,
      lastBookingTime: customer.lastBookingTime || null,
      lastBookingGuestCount: Number(customer.lastBookingGuestCount || 0),
      lastBookingZone: customer.lastBookingZone || null,
      lastBookingTotal: Number(customer.lastBookingTotal || 0),
      lastBookingBalance: Number(customer.lastBookingBalance || 0),
      lastBookingNotes: customer.lastBookingNotes || null,
      membershipCount: Number(customer.membershipCount || 0),
      activeMembershipCount: Number(customer.activeMembershipCount || 0),
      latestMembershipId: customer.latestMembershipId || null,
      membershipStatus: customer.membershipStatus || null,
      membershipProduct: customer.membershipProduct || null,
      membershipBookingId: customer.membershipBookingId || null,
      membershipBookingNumber: customer.membershipBookingNumber || null,
      membershipPurchasedAt: customer.membershipPurchasedAt || null,
      membershipActivatedAt: customer.membershipActivatedAt || null,
      membershipExpiresAt: customer.membershipExpiresAt || null,
      membershipPausedUntil: customer.membershipPausedUntil || null,
      membershipAutoRenew: Boolean(customer.membershipAutoRenew),
      membershipRedemptionsToday: Number(customer.membershipRedemptionsToday || 0),
      membershipRedemptionCount: Number(customer.membershipRedemptionCount || 0),
      waiverStatus: customer.waiverStatus || "none",
      engagementScore: Number(customer.engagementScore || 0),
      ...(customer.customAttributes && typeof customer.customAttributes === "object" ? customer.customAttributes : {}),
    },
    sourceSnapshot: customer,
    lastEngagedAt: customer.lastEngagedAt || customer.lastVisit || null,
  };
}

async function countDynamicSegmentsForLocation(models, locationId) {
  return models.CrmSegment.count({
    where: { locationId, segmentType: "dynamic", status: "active" },
  });
}

function normalizeMoviraWebhookRows(input = {}) {
  const body = input && typeof input === "object" ? input : {};
  const data = body.data && typeof body.data === "object" ? body.data : null;
  const candidate =
    body.customer ||
    body.contact ||
    body.guest ||
    body.member ||
    body.membershipMember ||
    data?.customer ||
    data?.contact ||
    data?.guest ||
    data?.member ||
    data?.membershipMember ||
    data ||
    null;
  const rows = Array.isArray(body.customers)
    ? body.customers
    : Array.isArray(body.contacts)
      ? body.contacts
      : Array.isArray(body.guests)
        ? body.guests
        : Array.isArray(body.members)
          ? body.members
          : Array.isArray(body.data)
            ? body.data
            : Array.isArray(data?.customers)
              ? data.customers
              : Array.isArray(data?.contacts)
                ? data.contacts
                : Array.isArray(data?.guests)
                  ? data.guests
                  : Array.isArray(data?.members)
                    ? data.members
                    : candidate
                      ? [candidate]
                      : [];
  return rows.filter((row) => row && typeof row === "object");
}

function resolveWebhookLocationId(input = {}, row = {}) {
  return input.locationId || row.locationId || row.location?.id;
}

async function processMoviraCustomerWebhook(input = {}) {
  const models = getModels();
  const rows = normalizeMoviraWebhookRows(input);
  if (!rows.length) throw badRequest("customer payload is required");

  const errors = [];
  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  const synced = [];
  const automationEvents = [];
  let locationId = null;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    try {
      const rowLocationId = requireLocation(resolveWebhookLocationId(input, row));
      if (!locationId) {
        locationId = rowLocationId;
        await contactFieldService.ensureSystemFields(locationId);
      } else if (locationId !== rowLocationId) {
        throw badRequest("Webhook batch must contain customers from one location");
      }

      const mapped = mapCoreCustomerToContact(row, { locationId });
      const result = await upsertContact({ ...mapped, skipFilterCountInvalidation: true });
      if (result.created) createdCount += 1;
      else updatedCount += 1;
      synced.push(result.contact);
      automationEvents.push({
        eventType: result.created ? "customer.created" : "contact.changed",
        contactId: result.contact.id,
        payload: { eventType: input.eventType || input.type || null, sourceType: result.contact.sourceType, source: "movira_webhook" },
      });
      (result.tagsAdded || []).forEach((tag) => automationEvents.push({
        eventType: "contact.tag_added",
        contactId: result.contact.id,
        tag,
        payload: { source: "movira_webhook" },
      }));
    } catch (err) {
      skippedCount += 1;
      errors.push({ row: index + 1, sourceId: row?.id || row?.guestId || row?.memberId, message: err.message });
    }
  }

  if (!locationId) throw badRequest("locationId is required");

  const job = await models.CrmContactImportJob.create({
    locationId,
    sourceType: "webhook",
    fileName: "Movira webhook sync",
    status: errors.length ? "completed_with_errors" : "completed",
    totalRows: rows.length,
    createdCount,
    updatedCount,
    skippedCount,
    errorCount: errors.length,
    fieldMapping: {
      id: "sourceRefId",
      name: "fullName",
      email: "email",
      phone: "phone",
      lifecycle: "lifecycle",
    },
    errors,
    payload: {
      eventType: input.eventType || input.type || null,
      source: "movira_webhook",
    },
    startedAt: new Date(),
    completedAt: new Date(),
    lastError: errors.length ? `${errors.length} rows failed` : null,
  });

  const dynamicSegments = await countDynamicSegmentsForLocation(models, locationId);
  await markContactFilterCountsStale(locationId, "movira_webhook");

  return {
    job: plain(job),
    contacts: synced.slice(0, 25),
    segmentsQueuedForRefresh: dynamicSegments,
    automationEvents,
  };
}

async function listImportJobs(query = {}) {
  const models = getModels();
  const locationId = requireLocation(query.locationId);
  const limit = Math.min(50, Math.max(1, Number(query.limit || 20)));
  const where = { locationId };
  if (query.sourceType) where.sourceType = cleanString(query.sourceType, 40);
  const jobs = await models.CrmContactImportJob.findAll({
    where,
    limit,
    order: [["createdAt", "DESC"]],
  });
  return jobs.map(plain);
}

async function getContactStats(query = {}) {
  const models = getModels();
  const locationId = requireLocation(query.locationId);
  const sourceWhere = query.sourceType ? { locationId, sourceType: cleanString(query.sourceType, 40) } : { locationId };
  const [total, subscribed, doNotContact, movira, csv, manual] = await Promise.all([
    models.CrmContact.count({ where: sourceWhere }),
    models.CrmContact.count({ where: { ...sourceWhere, marketingStatus: "subscribed", doNotContact: false } }),
    models.CrmContact.count({ where: { ...sourceWhere, doNotContact: true } }),
    models.CrmContact.count({ where: { locationId, sourceType: "movira" } }),
    models.CrmContact.count({ where: { locationId, sourceType: "csv" } }),
    models.CrmContact.count({ where: { locationId, sourceType: "manual" } }),
  ]);
  return { total, subscribed, doNotContact, movira, csv, manual };
}

async function loadCustomFields(locationId) {
  const models = getModels();
  const fields = await models.CrmContactField.findAll({
    where: { locationId, archivedAt: null },
  });
  return fields.map(plain);
}

// Builds the shared query scope for the grid / export / bulk-target resolution.
// A selected segment is resolved through its materialized membership table
// (crm_segment_members) so both filter-computed AND manually added members show.
// Ad-hoc advanced filters + free-text search compile against crm_contacts.
function buildSearchScope(models, locationId, { segmentId, filters, search, customFields = [] }) {
  const and = [];
  if (filters && hasFilterConditions(filters)) {
    assertLiveFilterGuardrails(filters);
    const fragment = filterEngine.compile(filters, { customFields });
    if (Object.keys(fragment).length) and.push(fragment);
  }
  const searchFragment = filterEngine.searchFragment(search);
  if (searchFragment) and.push(searchFragment);

  const where = and.length ? { locationId, [Op.and]: and } : { locationId };
  const include = segmentId
    ? [{
        model: models.CrmSegmentMember,
        as: "segmentMemberships",
        where: { segmentId, status: "active" },
        attributes: [],
        required: true,
      }]
    : [];
  const hasConstraint = and.length > 0 || Boolean(segmentId);
  return { where, include, hasConstraint, hasLiveConstraint: and.length > 0 };
}

async function getContactFilterCount(query = {}) {
  const models = getModels();
  const locationId = requireLocation(query.locationId);
  const scopeHash = cleanString(query.scopeHash, 64);
  if (!scopeHash) throw badRequest("scopeHash is required");
  const row = await models.CrmContactFilterCount.findOne({ where: { locationId, scopeHash } });
  if (!row) throw notFound("Contact filter count");
  return filterCountSnapshot(row, false);
}

async function scheduleContactFilterCount(input = {}) {
  const models = getModels();
  const locationId = requireLocation(input.locationId);
  const scope = contactFilterScope(input, locationId);
  const scopeHash = contactFilterScopeHash(scope);
  let queued = false;
  const [row, created] = await models.CrmContactFilterCount.findOrCreate({
    where: { locationId, scopeHash },
    defaults: { locationId, scopeHash, scope, status: "pending" },
  });

  const status = String(row.status || "pending");
  const shouldQueue = status === "failed"
    || (status === "completed" && isFilterCountStale(row))
    || !["pending", "processing", "completed"].includes(status);

  if (shouldQueue) {
    await row.update({ scope, status: "pending", lastError: null });
  }

  if (created || shouldQueue) {
    await queueJobs.enqueueJob({
      jobType: queueJobs.JOB_TYPES.CONTACTS_FILTER_COUNT,
      locationId,
      priority: 70,
      payload: { filterCountId: row.id },
    });
    queued = true;
  }

  return filterCountSnapshot(row, queued);
}

async function processContactFilterCountJob(filterCountId) {
  const models = getModels();
  const row = await models.CrmContactFilterCount.findByPk(filterCountId);
  if (!row) throw notFound("Contact filter count");
  const scope = row.scope || {};
  const locationId = requireLocation(scope.locationId || row.locationId);
  const jobStartedAt = new Date();
  await row.update({ status: "processing", lastError: null });

  try {
    const customFields = await loadCustomFields(locationId);
    const { where, include } = buildSearchScope(models, locationId, {
      segmentId: scope.segmentId,
      filters: scope.filters,
      search: scope.search,
      customFields,
    });
    const total = await models.CrmContact.count({
      where,
      include,
      distinct: include.length > 0,
    });
    await row.reload();
    if (row.invalidatedAt && new Date(row.invalidatedAt).getTime() > jobStartedAt.getTime()) {
      const stale = await row.update({
        status: "stale",
        total,
        calculatedAt: null,
        lastError: "filter_count_invalidated_during_processing",
      });
      await queueJobs.enqueueJob({
        jobType: queueJobs.JOB_TYPES.CONTACTS_FILTER_COUNT,
        locationId,
        priority: 70,
        payload: { filterCountId: row.id },
      });
      return filterCountSnapshot(stale, true);
    }
    const updated = await row.update({
      status: "completed",
      total,
      calculatedAt: new Date(),
      invalidatedAt: null,
      lastError: null,
    });
    return filterCountSnapshot(updated, false);
  } catch (err) {
    await row.update({
      status: "failed",
      lastError: err.message || String(err || "Count failed"),
    });
    throw err;
  }
}

// Powers the customers grid: advanced filter tree + free-text
// search + optional saved segment, with sortable columns and pagination.
async function searchContacts(input = {}) {
  const models = getModels();
  const locationId = requireLocation(input.locationId);
  const page = Math.max(1, Number(input.page || 1));
  const pageSize = Math.min(200, Math.max(1, Number(input.pageSize || 50)));

  const sortBy = catalog.SORTABLE_COLUMNS.has(input.sortBy) ? input.sortBy : "updatedAt";
  const sortDir = String(input.sortDir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

  const customFields = await loadCustomFields(locationId);
  const { where, include, hasLiveConstraint } = buildSearchScope(models, locationId, {
    segmentId: input.segmentId,
    filters: input.filters,
    search: input.search,
    customFields,
  });

  if (hasLiveConstraint) {
    const filteredCount = await scheduleContactFilterCount({ ...input, locationId });
    const rows = await models.CrmContact.findAll({
      where,
      include,
      limit: pageSize + 1,
      offset: (page - 1) * pageSize,
      order: [[sortBy, sortDir]],
    });
    const hasMore = rows.length > pageSize;
    return {
      items: rows.slice(0, pageSize).map(plain),
      page,
      pageSize,
      total: null,
      hasMore,
      sortBy,
      sortDir: sortDir.toLowerCase(),
      countMode: "skipped_for_live_filter",
      filteredCount,
    };
  }

  const result = await models.CrmContact.findAndCountAll({
    where,
    include,
    distinct: include.length > 0,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    order: [[sortBy, sortDir]],
  });

  return {
    items: result.rows.map(plain),
    page,
    pageSize,
    total: result.count,
    hasMore: page * pageSize < result.count,
    sortBy,
    sortDir: sortDir.toLowerCase(),
  };
}

async function resolveBulkTargetIds(models, locationId, input, customFields) {
  if (Array.isArray(input.ids) && input.ids.length) {
    const rows = await models.CrmContact.findAll({
      where: { locationId, id: { [Op.in]: input.ids.slice(0, 10000) } },
      attributes: ["id"],
    });
    return rows.map((row) => row.id);
  }
  const { where, include, hasConstraint } = buildSearchScope(models, locationId, {
    segmentId: input.segmentId,
    filters: input.filters,
    search: input.search,
    customFields,
  });
  if (!hasConstraint && !input.allowAll) return [];
  const rows = await models.CrmContact.findAll({ where, include, attributes: ["id"], limit: 10000 });
  return rows.map((row) => row.id);
}

function validateBulkActionInput(input = {}) {
  const action = cleanString(input.action, 40);
  if (!action) throw badRequest("action is required");
  const payload = {};

  if (action === "set_marketing_status") {
    const status = cleanString(input.marketingStatus, 40);
    if (!VALID_MARKETING_STATUSES.has(status)) throw badRequest(`Unsupported marketingStatus: ${status}`);
    payload.marketingStatus = status;
  } else if (action === "set_do_not_contact") {
    payload.doNotContact = Boolean(input.doNotContact);
  } else if (action === "set_lifecycle") {
    const lifecycle = cleanString(input.lifecycle, 40);
    if (!VALID_LIFECYCLES.has(lifecycle)) throw badRequest(`Unsupported lifecycle: ${lifecycle}`);
    payload.lifecycle = lifecycle;
  } else if (action === "add_tags" || action === "remove_tags") {
    const tags = normalizeTags(input.tags);
    if (!tags.length) throw badRequest("tags is required");
    payload.tags = tags;
  } else if (action === "add_to_segment") {
    const targetSegmentId = cleanString(input.targetSegmentId || input.segmentId, 80);
    if (!targetSegmentId) throw badRequest("targetSegmentId is required");
    payload.targetSegmentId = targetSegmentId;
  } else if (action !== "delete") {
    throw badRequest(`Unsupported bulk action: ${action}`);
  }

  return { action, payload };
}

function bulkSelectionFromInput(input = {}) {
  if (Array.isArray(input.ids) && input.ids.length) {
    return { mode: "ids", ids: input.ids.slice(0, 100000).map((id) => cleanString(id, 80)).filter(Boolean) };
  }
  return {
    mode: "scope",
    segmentId: cleanString(input.segmentId, 80),
    filters: input.filters && typeof input.filters === "object" ? input.filters : null,
    search: cleanString(input.search, 120),
    allowAll: Boolean(input.allowAll),
  };
}

function exportSelectionFromInput(input = {}) {
  return {
    mode: "scope",
    segmentId: cleanString(input.segmentId, 80),
    filters: input.filters && typeof input.filters === "object" ? input.filters : null,
    search: cleanString(input.search, 120),
    allowAll: true,
  };
}

function shouldQueueBulkAction(input = {}) {
  if (input.queue === true || input.queue === "true") return true;
  if (input.allowAll) return true;
  if (Array.isArray(input.ids) && input.ids.length > BULK_ACTION_DIRECT_LIMIT) return true;
  return false;
}

async function createContactBulkActionJob(input = {}) {
  const models = getModels();
  const locationId = requireLocation(input.locationId);
  const { action, payload } = validateBulkActionInput(input);
  if (action === "add_to_segment") {
    const segment = await models.CrmSegment.findOne({ where: { id: payload.targetSegmentId, locationId } });
    if (!segment) throw notFound("Segment");
  }
  const selection = bulkSelectionFromInput(input);
  if (selection.mode === "scope" && !selection.allowAll && !selection.segmentId && !selection.filters && !selection.search) {
    return { action, queued: false, affected: 0 };
  }

  const job = await models.CrmContactBulkActionJob.create({
    locationId,
    action,
    selection,
    payload,
    status: "queued",
  });
  const queueJob = await queueJobs.enqueueJob({
    jobType: queueJobs.JOB_TYPES.CONTACTS_BULK_ACTION,
    locationId,
    priority: 65,
    payload: { bulkActionJobId: job.id },
  });
  return {
    action,
    queued: true,
    affected: 0,
    bulkActionJob: plain(job),
    queueJob,
  };
}

async function listContactBulkActionJobs(query = {}) {
  const models = getModels();
  const locationId = requireLocation(query.locationId);
  const limit = Math.min(50, Math.max(1, Number(query.limit || 20)));
  const where = { locationId };
  if (query.status) where.status = cleanString(query.status, 40);
  const jobs = await models.CrmContactBulkActionJob.findAll({
    where,
    limit,
    order: [["createdAt", "DESC"]],
  });
  return jobs.map(plain);
}

async function getContactBulkActionJob(id, query = {}) {
  const models = getModels();
  const locationId = requireLocation(query.locationId);
  const job = await models.CrmContactBulkActionJob.findOne({ where: { id, locationId } });
  if (!job) throw notFound("Contact bulk action job");
  return plain(job);
}

// Multi-select bulk operations from the grid: tagging, status changes, deletes,
// and adding selections to a segment as manual members.
async function bulkUpdateContacts(input = {}) {
  const models = getModels();
  const locationId = requireLocation(input.locationId);
  if (shouldQueueBulkAction(input)) return createContactBulkActionJob(input);
  const { action } = validateBulkActionInput(input);

  const customFields = await loadCustomFields(locationId);
  const ids = await resolveBulkTargetIds(models, locationId, input, customFields);
  if (!ids.length) return { action, affected: 0 };

  const scope = { locationId, id: { [Op.in]: ids } };

  if (action === "delete") {
    await models.sequelize.transaction(async (transaction) => {
      await models.CrmSegmentMember.destroy({ where: { locationId, contactId: { [Op.in]: ids } }, transaction });
      await models.CrmContactIdentity.destroy({ where: { locationId, contactId: { [Op.in]: ids } }, transaction });
      await models.CrmContact.destroy({ where: scope, transaction });
    });
    await markContactFilterCountsStale(locationId, "contacts_bulk_delete");
    return { action, affected: ids.length };
  }

  if (action === "set_marketing_status") {
    const status = cleanString(input.marketingStatus, 40);
    if (!VALID_MARKETING_STATUSES.has(status)) throw badRequest(`Unsupported marketingStatus: ${status}`);
    const [affected] = await models.CrmContact.update({ marketingStatus: status }, { where: scope });
    await markContactFilterCountsStale(locationId, "contacts_bulk_marketing_status");
    return { action, affected };
  }

  if (action === "set_do_not_contact") {
    const value = Boolean(input.doNotContact);
    const [affected] = await models.CrmContact.update({ doNotContact: value }, { where: scope });
    await markContactFilterCountsStale(locationId, "contacts_bulk_do_not_contact");
    return { action, affected };
  }

  if (action === "set_lifecycle") {
    const lifecycle = cleanString(input.lifecycle, 40);
    if (!VALID_LIFECYCLES.has(lifecycle)) throw badRequest(`Unsupported lifecycle: ${lifecycle}`);
    const [affected] = await models.CrmContact.update({ lifecycle }, { where: scope });
    await markContactFilterCountsStale(locationId, "contacts_bulk_lifecycle");
    return { action, affected };
  }

  if (action === "add_tags" || action === "remove_tags") {
    const tags = normalizeTags(input.tags);
    if (!tags.length) throw badRequest("tags is required");
    const removeSet = new Set(tags.map(tagKey));
    const contacts = await models.CrmContact.findAll({ where: scope });
    const addedEvents = [];
    await models.sequelize.transaction(async (transaction) => {
      if (action === "add_tags") await ensureContactTags(models, locationId, tags, transaction);
      for (const contact of contacts) {
        const before = normalizeTags(contact.tags);
        const next = action === "add_tags"
          ? mergeTags(contact.tags, tags)
          : normalizeTags(contact.tags).filter((tag) => !removeSet.has(tagKey(tag)));
        await contact.update({ tags: next }, { transaction });
        if (action === "add_tags") {
          diffTags(before, next).forEach((tag) => addedEvents.push({ contactId: contact.id, tag }));
        }
      }
    });
    const segmentsQueuedForRefresh = await countDynamicSegmentsForLocation(models, locationId);
    await markContactFilterCountsStale(locationId, `contacts_bulk_${action}`);
    return { action, affected: contacts.length, segmentsQueuedForRefresh, tagsAdded: addedEvents };
  }

  if (action === "add_to_segment") {
    // targetSegmentId is the destination; keep it distinct from input.segmentId,
    // which (if present) only scopes the selection source.
    const destinationId = input.targetSegmentId || input.segmentId;
    const segment = await models.CrmSegment.findOne({ where: { id: destinationId, locationId } });
    if (!segment) throw notFound("Segment");
    await models.sequelize.transaction(async (transaction) => {
      const enteredAt = new Date();
      await models.CrmSegmentMember.update(
        { source: "manual", status: "active", enteredAt, exitedAt: null },
        { where: { segmentId: segment.id, contactId: { [Op.in]: ids } }, transaction }
      );
      await models.CrmSegmentMember.bulkCreate(
        ids.map((contactId) => ({
          segmentId: segment.id,
          contactId,
          locationId,
          source: "manual",
          status: "active",
          enteredAt,
          exitedAt: null,
        })),
        { ignoreDuplicates: true, transaction }
      );
      const memberCount = await models.CrmSegmentMember.count({
        where: { segmentId: segment.id, status: "active" },
        transaction,
      });
      await segment.update({ memberCount }, { transaction });
    });
    await markContactFilterCountsStale(locationId, "contacts_bulk_add_to_segment");
    return { action, affected: ids.length, segmentId: segment.id, memberContactIds: ids };
  }

  throw badRequest(`Unsupported bulk action: ${action}`);
}

async function bulkSelectionBatch(models, locationId, selection = {}, customFields = [], lastId = null) {
  if (selection.mode === "ids") {
    const ids = Array.isArray(selection.ids) ? selection.ids : [];
    const start = lastId ? Number(lastId) : 0;
    const chunk = ids.slice(start, start + BULK_ACTION_BATCH_SIZE);
    if (!chunk.length) return { ids: [], nextCursor: null, done: true };
    const rows = await models.CrmContact.findAll({
      where: { locationId, id: { [Op.in]: chunk } },
      attributes: ["id"],
      order: [["id", "ASC"]],
      raw: true,
    });
    const nextCursor = start + chunk.length;
    return { ids: rows.map((row) => row.id), nextCursor, done: nextCursor >= ids.length };
  }

  const { where, include, hasConstraint } = buildSearchScope(models, locationId, {
    segmentId: selection.segmentId,
    filters: selection.filters,
    search: selection.search,
    customFields,
  });
  if (!hasConstraint && !selection.allowAll) return { ids: [], nextCursor: null, done: true };
  const cursorWhere = lastId ? { ...where, id: { [Op.gt]: lastId } } : where;
  const rows = await models.CrmContact.findAll({
    where: cursorWhere,
    include,
    attributes: ["id"],
    limit: BULK_ACTION_BATCH_SIZE,
    order: [["id", "ASC"]],
    raw: true,
  });
  return {
    ids: rows.map((row) => row.id),
    nextCursor: rows.length ? rows[rows.length - 1].id : null,
    done: rows.length < BULK_ACTION_BATCH_SIZE,
  };
}

async function countBulkSelection(models, locationId, selection = {}, customFields = []) {
  if (selection.mode === "ids") {
    const ids = Array.isArray(selection.ids) ? selection.ids : [];
    if (!ids.length) return 0;
    return models.CrmContact.count({ where: { locationId, id: { [Op.in]: ids } } });
  }
  const { where, include, hasConstraint } = buildSearchScope(models, locationId, {
    segmentId: selection.segmentId,
    filters: selection.filters,
    search: selection.search,
    customFields,
  });
  if (!hasConstraint && !selection.allowAll) return 0;
  return models.CrmContact.count({ where, include, distinct: include.length > 0 });
}

async function applyBulkActionBatch(models, locationId, action, payload = {}, ids = []) {
  if (!ids.length) return { affected: 0, tagsAdded: [] };
  const scope = { locationId, id: { [Op.in]: ids } };

  if (action === "delete") {
    await models.sequelize.transaction(async (transaction) => {
      await models.CrmSegmentMember.destroy({ where: { locationId, contactId: { [Op.in]: ids } }, transaction });
      await models.CrmContactIdentity.destroy({ where: { locationId, contactId: { [Op.in]: ids } }, transaction });
      await models.CrmContact.destroy({ where: scope, transaction });
    });
    return { affected: ids.length, tagsAdded: [] };
  }

  if (action === "set_marketing_status") {
    const [affected] = await models.CrmContact.update({ marketingStatus: payload.marketingStatus }, { where: scope });
    return { affected, tagsAdded: [] };
  }

  if (action === "set_do_not_contact") {
    const [affected] = await models.CrmContact.update({ doNotContact: Boolean(payload.doNotContact) }, { where: scope });
    return { affected, tagsAdded: [] };
  }

  if (action === "set_lifecycle") {
    const [affected] = await models.CrmContact.update({ lifecycle: payload.lifecycle }, { where: scope });
    return { affected, tagsAdded: [] };
  }

  if (action === "add_tags" || action === "remove_tags") {
    const tags = normalizeTags(payload.tags);
    const removeSet = new Set(tags.map(tagKey));
    const contacts = await models.CrmContact.findAll({ where: scope });
    const tagsAdded = [];
    await models.sequelize.transaction(async (transaction) => {
      if (action === "add_tags") await ensureContactTags(models, locationId, tags, transaction);
      for (const contact of contacts) {
        const before = normalizeTags(contact.tags);
        const next = action === "add_tags"
          ? mergeTags(contact.tags, tags)
          : normalizeTags(contact.tags).filter((tag) => !removeSet.has(tagKey(tag)));
        await contact.update({ tags: next }, { transaction });
        if (action === "add_tags") {
          diffTags(before, next).forEach((tag) => tagsAdded.push({ contactId: contact.id, tag }));
        }
      }
    });
    return { affected: contacts.length, tagsAdded };
  }

  if (action === "add_to_segment") {
    const segment = await models.CrmSegment.findOne({ where: { id: payload.targetSegmentId, locationId } });
    if (!segment) throw notFound("Segment");
    await models.sequelize.transaction(async (transaction) => {
      const enteredAt = new Date();
      await models.CrmSegmentMember.update(
        { source: "manual", status: "active", enteredAt, exitedAt: null },
        { where: { segmentId: segment.id, contactId: { [Op.in]: ids } }, transaction }
      );
      await models.CrmSegmentMember.bulkCreate(
        ids.map((contactId) => ({
          segmentId: segment.id,
          contactId,
          locationId,
          source: "manual",
          status: "active",
          enteredAt,
          exitedAt: null,
        })),
        { ignoreDuplicates: true, transaction }
      );
    });
    return { affected: ids.length, tagsAdded: [], segmentId: segment.id, memberContactIds: ids };
  }

  throw badRequest(`Unsupported bulk action: ${action}`);
}

async function processContactBulkActionJob(jobId) {
  const models = getModels();
  const job = await models.CrmContactBulkActionJob.findByPk(jobId);
  if (!job) throw notFound("Contact bulk action job");
  const locationId = requireLocation(job.locationId);
  const customFields = await loadCustomFields(locationId);
  const selection = job.selection || {};
  const payload = job.payload || {};
  let processedCount = 0;
  let affectedCount = 0;
  let failedCount = 0;
  let cursor = null;
  const errors = [];

  await job.update({
    status: "processing",
    startedAt: job.startedAt || new Date(),
    lastError: null,
    totalTargeted: await countBulkSelection(models, locationId, selection, customFields),
  });

  while (true) {
    const batch = await bulkSelectionBatch(models, locationId, selection, customFields, cursor);
    cursor = batch.nextCursor;
    if (!batch.ids.length) break;

    try {
      const result = await applyBulkActionBatch(models, locationId, job.action, payload, batch.ids);
      affectedCount += Number(result.affected || 0);
      if (result.tagsAdded?.length) {
        await queueJobs.enqueueAutomationEvents(result.tagsAdded.map((item) => ({
          eventType: "contact.tag_added",
          contactId: item.contactId,
          tag: item.tag,
          locationId,
          source: "contacts_bulk_action",
          payload: { bulkActionJobId: job.id, action: job.action },
        })), { locationId, source: "contacts_bulk_action" });
      }
    } catch (err) {
      failedCount += batch.ids.length;
      errors.push({ cursor, message: err.message || String(err || "Bulk batch failed") });
      if (errors.length > 10) errors.shift();
    }

    processedCount += batch.ids.length;
    await job.update({ processedCount, affectedCount, failedCount, errors });
    if (batch.done) break;
  }

  if (job.action === "add_to_segment" && payload.targetSegmentId) {
    const segment = await models.CrmSegment.findOne({ where: { id: payload.targetSegmentId, locationId } });
    if (segment) {
      const memberCount = await models.CrmSegmentMember.count({ where: { segmentId: segment.id, status: "active" } });
      await segment.update({ memberCount });
    }
  }

  const segmentsQueuedForRefresh = await countDynamicSegmentsForLocation(models, locationId);
  await queueJobs.enqueueSegmentRefreshForLocation(locationId, {
    source: "contacts_bulk_action",
    bulkActionJobId: job.id,
    action: job.action,
  });

  const updated = await job.update({
    status: failedCount ? "completed_with_errors" : "completed",
    processedCount,
    affectedCount,
    failedCount,
    errors,
    completedAt: new Date(),
    lastError: failedCount ? `${failedCount} contacts failed` : null,
  });
  await markContactFilterCountsStale(locationId, "contacts_bulk_action");

  return { ...plain(updated), segmentsQueuedForRefresh };
}

// Distinct tags across a location's customers — powers tag autocomplete.
async function listContactTags(query = {}) {
  const models = getModels();
  const locationId = requireLocation(query.locationId);
  const search = cleanString(query.search, 80);
  const limit = Math.min(200, Math.max(1, Number(query.limit || 100)));
  const detailed = query.detailed === true || query.detailed === "true";
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize || limit || 25)));

  const rows = await models.sequelize.query(
    `SELECT tag, COUNT(*)::int AS "contactCount" FROM (
       SELECT jsonb_array_elements_text(tags) AS tag
       FROM crm_contacts WHERE "locationId" = :locationId
     ) t
     WHERE tag <> ''${search ? " AND tag ILIKE :search" : ""}
     GROUP BY tag
     ORDER BY tag ASC`,
    {
      replacements: { locationId, ...(search ? { search: `%${search}%` } : {}) },
      type: models.sequelize.QueryTypes.SELECT,
    }
  );

  if (!detailed) return rows.slice(0, limit).map((row) => row.tag);

  const registryWhere = { locationId };
  if (search) {
    registryWhere[Op.or] = [
      { name: { [Op.iLike]: `%${search}%` } },
      { description: { [Op.iLike]: `%${search}%` } },
    ];
  }
  const registryRows = await models.CrmContactTag.findAll({ where: registryWhere, order: [["name", "ASC"]] });
  const byKey = new Map();
  rows.forEach((row) => {
    const name = normalizeTagName(row.tag);
    if (!name) return;
    byKey.set(tagKey(name), {
      id: null,
      name,
      normalizedName: tagKey(name),
      description: null,
      color: null,
      contactCount: Number(row.contactCount || 0),
      source: "contacts",
      createdAt: null,
      updatedAt: null,
    });
  });
  registryRows.map(plain).forEach((tag) => {
    const key = tagKey(tag.normalizedName || tag.name);
    const existing = byKey.get(key);
    byKey.set(key, {
      ...existing,
      ...tag,
      normalizedName: key,
      contactCount: existing?.contactCount || 0,
      source: existing ? "registry_contacts" : "registry",
    });
  });

  const items = Array.from(byKey.values()).sort((a, b) => a.name.localeCompare(b.name));
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    total: items.length,
  };
}

async function createContactTag(input = {}) {
  const models = getModels();
  const locationId = requireLocation(input.locationId);
  const name = normalizeTagName(input.name);
  if (!name) throw badRequest("Tag name is required");
  const normalizedName = tagKey(name);
  const payload = {
    locationId,
    name,
    normalizedName,
    description: cleanString(input.description, 500),
    color: cleanColor(input.color),
    createdBy: cleanString(input.createdBy, 120),
  };
  const [tag, created] = await models.CrmContactTag.findOrCreate({
    where: { locationId, normalizedName },
    defaults: payload,
  });
  if (!created) {
    const updated = await tag.update({
      name,
      description: input.description === undefined ? tag.description : payload.description,
      color: input.color === undefined ? tag.color : payload.color,
    });
    return plain(updated);
  }
  return plain(tag);
}

async function updateContactTag(tagName, input = {}) {
  const models = getModels();
  const locationId = requireLocation(input.locationId);
  const currentName = normalizeTagName(tagName || input.currentName || input.oldName);
  const nextName = normalizeTagName(input.newName || input.name || currentName);
  if (!currentName) throw badRequest("Tag name is required");
  if (!nextName) throw badRequest("New tag name is required");

  const currentKey = tagKey(currentName);
  const nextKey = tagKey(nextName);
  const currentRegistry = await models.CrmContactTag.findOne({ where: { locationId, normalizedName: currentKey } });
  const collision = currentKey !== nextKey
    ? await models.CrmContactTag.findOne({ where: { locationId, normalizedName: nextKey } })
    : null;
  if (collision) throw badRequest(`Tag "${nextName}" already exists`);

  const result = await models.sequelize.transaction(async (transaction) => {
    let registry = currentRegistry;
    if (!registry) {
      registry = await models.CrmContactTag.create({
        locationId,
        name: currentName,
        normalizedName: currentKey,
      }, { transaction });
    }

    const contacts = await models.CrmContact.findAll({ where: { locationId }, transaction });
    let affected = 0;
    if (currentKey !== nextKey) {
      for (const contact of contacts) {
        const tags = normalizeTags(contact.tags);
        if (!tags.some((tag) => tagKey(tag) === currentKey)) continue;
        const nextTags = [];
        tags.forEach((tag) => {
          const value = tagKey(tag) === currentKey ? nextName : tag;
          if (!nextTags.some((existing) => tagKey(existing) === tagKey(value))) nextTags.push(value);
        });
        await contact.update({ tags: nextTags }, { transaction });
        affected += 1;
      }
    }

    const updated = await registry.update({
      name: nextName,
      normalizedName: nextKey,
      description: input.description === undefined ? registry.description : cleanString(input.description, 500),
      color: input.color === undefined ? registry.color : cleanColor(input.color),
    }, { transaction });

    return { tag: plain(updated), affected };
  });
  const segmentsQueuedForRefresh = await countDynamicSegmentsForLocation(models, locationId);
  if (result.affected) await markContactFilterCountsStale(locationId, "contact_tag_updated");
  return { ...result, segmentsQueuedForRefresh };
}

async function deleteContactTag(tagName, input = {}) {
  const models = getModels();
  const locationId = requireLocation(input.locationId);
  const name = normalizeTagName(tagName || input.name);
  if (!name) throw badRequest("Tag name is required");
  const key = tagKey(name);

  const result = await models.sequelize.transaction(async (transaction) => {
    const registry = await models.CrmContactTag.findOne({ where: { locationId, normalizedName: key }, transaction });
    const contacts = await models.CrmContact.findAll({ where: { locationId }, transaction });
    let affected = 0;
    for (const contact of contacts) {
      const tags = normalizeTags(contact.tags);
      if (!tags.some((tag) => tagKey(tag) === key)) continue;
      await contact.update({ tags: tags.filter((tag) => tagKey(tag) !== key) }, { transaction });
      affected += 1;
    }
    if (registry) await registry.destroy({ transaction });
    return { name, affected };
  });
  const segmentsQueuedForRefresh = await countDynamicSegmentsForLocation(models, locationId);
  if (result.affected) await markContactFilterCountsStale(locationId, "contact_tag_deleted");
  return { ...result, segmentsQueuedForRefresh };
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function contactExportHeaders(customFields = []) {
  const baseHeaders = [
    ["fullName", "Name"], ["firstName", "First name"], ["lastName", "Last name"],
    ["email", "Email"], ["phone", "Phone"], ["lifecycle", "Lifecycle"],
    ["marketingStatus", "Marketing status"], ["smsStatus", "SMS status"],
    ["sourceType", "Source"], ["doNotContact", "Do not contact"], ["tags", "Tags"],
    ["createdAt", "Created"], ["updatedAt", "Last activity"],
  ];
  const header = [...baseHeaders.map((h) => h[1]), ...customFields.map((f) => f.label)];
  return { baseHeaders, header };
}

function contactExportLine(contact, baseHeaders, customFields = []) {
  const base = baseHeaders.map(([key]) => {
    if (key === "tags") return Array.isArray(contact.tags) ? contact.tags.join("; ") : "";
    if (key === "doNotContact") return contact.doNotContact ? "yes" : "no";
    return contact[key];
  });
  const custom = customFields.map((f) => (contact.customFields ? contact.customFields[f.key] : ""));
  return [...base, ...custom].map(csvCell).join(",");
}

function shouldQueueExport(input = {}) {
  if (input.queue === true || input.queue === "true") return true;
  if (input.allowAll === true || input.allowAll === "true") return true;
  return Number(input.limit || EXPORT_DIRECT_LIMIT) > EXPORT_DIRECT_LIMIT;
}

function exportJobSnapshot(job) {
  const data = plain(job);
  if (!data) return null;
  return {
    ...data,
    downloadUrl: data.status === "completed" ? `/contacts/export-jobs/${data.id}/download` : data.downloadUrl,
  };
}

async function createContactExportJob(input = {}) {
  const models = getModels();
  const locationId = requireLocation(input.locationId);
  const job = await models.CrmContactExportJob.create({
    locationId,
    selection: exportSelectionFromInput(input),
    status: "queued",
    fileName: `customers-${Date.now()}.csv`,
  });
  const queueJob = await queueJobs.enqueueJob({
    jobType: queueJobs.JOB_TYPES.CONTACTS_EXPORT,
    locationId,
    priority: 75,
    payload: { exportJobId: job.id },
  });
  return { queued: true, exportJob: exportJobSnapshot(job), queueJob };
}

async function listContactExportJobs(query = {}) {
  const models = getModels();
  const locationId = requireLocation(query.locationId);
  const limit = Math.min(50, Math.max(1, Number(query.limit || 20)));
  const where = { locationId };
  if (query.status) where.status = cleanString(query.status, 40);
  const jobs = await models.CrmContactExportJob.findAll({ where, limit, order: [["createdAt", "DESC"]] });
  return jobs.map(exportJobSnapshot);
}

async function getContactExportJob(id, query = {}) {
  const models = getModels();
  const locationId = requireLocation(query.locationId);
  const job = await models.CrmContactExportJob.findOne({ where: { id, locationId } });
  if (!job) throw notFound("Contact export job");
  return exportJobSnapshot(job);
}

async function getContactExportFile(id, query = {}) {
  const models = getModels();
  const locationId = requireLocation(query.locationId);
  const job = await models.CrmContactExportJob.findOne({ where: { id, locationId } });
  if (!job) throw notFound("Contact export job");
  if (job.status !== "completed") throw badRequest("Export is not ready");
  if (job.storageType === "s3") {
    const opened = await exportStorage.openContactExport({
      storageType: "s3",
      storageBucket: job.storageBucket,
      storageKey: job.storageKey,
    });
    return { ...opened, fileName: job.fileName || `customers-${job.id}.csv` };
  }
  if (!job.filePath) throw badRequest("Export is not ready");
  const resolved = path.resolve(job.filePath);
  const root = path.resolve(EXPORT_DIR);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw badRequest("Invalid export file path");
  if (!fs.existsSync(resolved)) throw notFound("Export file");
  return {
    storageType: "local",
    ...(await exportStorage.openContactExport({ storageType: "local", filePath: resolved })),
    fileName: job.fileName || `customers-${job.id}.csv`,
  };
}

async function processContactExportJob(jobId) {
  const models = getModels();
  const job = await models.CrmContactExportJob.findByPk(jobId);
  if (!job) throw notFound("Contact export job");
  const locationId = requireLocation(job.locationId);
  const customFields = await loadCustomFields(locationId);
  const selection = job.selection || {};
  const totalRows = await countBulkSelection(models, locationId, selection, customFields);
  const fileName = job.fileName || `customers-${Date.now()}.csv`;
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const filePath = path.join(EXPORT_DIR, `${job.id}.csv`);
  const { baseHeaders, header } = contactExportHeaders(customFields);
  const stream = fs.createWriteStream(filePath, { encoding: "utf8" });
  stream.write(`${header.map(csvCell).join(",")}\n`);

  let exportedRows = 0;
  let cursor = null;
  await job.update({
    status: "processing",
    startedAt: job.startedAt || new Date(),
    totalRows,
    fileName,
    filePath,
    lastError: null,
  });

  try {
    while (true) {
      const batch = await bulkSelectionBatch(models, locationId, selection, customFields, cursor);
      cursor = batch.nextCursor;
      if (!batch.ids.length) break;
      const contacts = await models.CrmContact.findAll({
        where: { locationId, id: { [Op.in]: batch.ids } },
        order: [["id", "ASC"]],
      });
      for (const contact of contacts.map(plain)) {
        stream.write(`${contactExportLine(contact, baseHeaders, customFields)}\n`);
        exportedRows += 1;
      }
      await job.update({ exportedRows });
      if (batch.done) break;
    }

    await new Promise((resolve, reject) => {
      stream.end(resolve);
      stream.on("error", reject);
    });
    const storage = await exportStorage.uploadContactExport({
      locationId,
      jobId: job.id,
      fileName,
      filePath,
    });
    const updated = await job.update({
      status: "completed",
      exportedRows,
      completedAt: new Date(),
      downloadUrl: `/contacts/export-jobs/${job.id}/download`,
      storageType: storage.storageType,
      storageBucket: storage.storageBucket,
      storageKey: storage.storageKey,
      filePath: storage.filePath,
      lastError: null,
    });
    return exportJobSnapshot(updated);
  } catch (err) {
    stream.destroy();
    await job.update({ status: "failed", exportedRows, lastError: err.message || String(err || "Export failed"), completedAt: new Date() });
    throw err;
  }
}

// Exports the matching customers (same filter as the grid) as a CSV string.
async function exportContacts(input = {}) {
  const models = getModels();
  const locationId = requireLocation(input.locationId);
  if (shouldQueueExport(input)) return createContactExportJob({ ...input, locationId });
  const cap = Math.min(EXPORT_DIRECT_LIMIT, Math.max(1, Number(input.limit || EXPORT_DIRECT_LIMIT)));
  const customFields = await loadCustomFields(locationId);

  const { where, include } = buildSearchScope(models, locationId, {
    segmentId: input.segmentId,
    filters: input.filters,
    search: input.search,
    customFields,
  });

  const rows = await models.CrmContact.findAll({ where, include, order: [["updatedAt", "DESC"]], limit: cap });

  const { baseHeaders, header } = contactExportHeaders(customFields);
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(contactExportLine(plain(row), baseHeaders, customFields));
  }

  return { csv: lines.join("\n"), count: rows.length, fileName: `customers-${Date.now()}.csv` };
}

async function deleteContact(id, query = {}) {
  const models = getModels();
  const locationId = requireLocation(query.locationId);
  const contact = await models.CrmContact.findOne({ where: { id, locationId } });
  if (!contact) throw notFound("Contact");
  const data = plain(contact);
  await models.sequelize.transaction(async (transaction) => {
    await models.CrmSegmentMember.destroy({ where: { locationId, contactId: id }, transaction });
    await models.CrmContactIdentity.destroy({ where: { locationId, contactId: id }, transaction });
    await contact.destroy({ transaction });
  });
  await markContactFilterCountsStale(locationId, "contact_deleted");
  return data;
}

async function deleteMoviraContact(input = {}) {
  const models = getModels();
  const locationId = requireLocation(input.locationId);
  const customerId = cleanString(
    input.customerId || input.externalId || input.sourceRefId,
    160
  );
  if (!customerId) throw badRequest("customerId is required");

  const identity = await models.CrmContactIdentity.findOne({
    where: {
      locationId,
      provider: "movira",
      externalType: "guest",
      externalId: customerId,
    },
  });
  if (!identity) {
    return { deleted: false, reason: "contact_not_found", customerId, locationId };
  }
  const contact = await models.CrmContact.findOne({
    where: { id: identity.contactId, locationId },
  });
  if (!contact) {
    await identity.destroy();
    return { deleted: false, reason: "contact_not_found", customerId, locationId };
  }
  const deleted = await deleteContact(contact.id, { locationId });
  return { deleted: true, customerId, locationId, contact: deleted };
}

module.exports = {
  upsertContact,
  listContacts,
  searchContacts,
  getContactFilterCount,
  scheduleContactFilterCount,
  processContactFilterCountJob,
  markContactFilterCountsStale,
  loadCustomFields,
  buildSearchScope,
  bulkUpdateContacts,
  createContactBulkActionJob,
  listContactBulkActionJobs,
  getContactBulkActionJob,
  processContactBulkActionJob,
  listContactTags,
  createContactTag,
  updateContactTag,
  deleteContactTag,
  exportContacts,
  createContactExportJob,
  listContactExportJobs,
  getContactExportJob,
  getContactExportFile,
  processContactExportJob,
  deleteContact,
  deleteMoviraContact,
  getContact,
  updateContact,
  processMoviraCustomerWebhook,
  listImportJobs,
  getContactStats,
  normalizeEmail,
  normalizePhone,
};
