// CRM Marketing → Email service.
//
// Concerns:
//   - Folders (campaign + template hierarchies).
//   - Templates (design / code / plain editors).
//   - Campaigns (draft → scheduled → sent + denormalised aggregates).
//   - Statistics (engagement, performance, top-performers).

const { Op } = require("sequelize");
const config = require("../../../config");
const { getModels } = require("../../../db/models");
const { createDefaultDesign } = require("./builder/defaultDesign");
const { renderDesign, interpolate } = require("./builder/renderer");
const { renderRawTemplate } = require("./rawTemplateRenderer");
const { getBuilderCatalog } = require("./builder/catalog");
const { getMergeTagCatalog } = require("./builder/mergeTags");
const { validateDesign } = require("./builder/schema");
const emailProvider = require("../../messaging-core/providers/emailProviderRouter");
const { enqueueMarketingMessage, assertMarketingQueueConfigured } = require("../../messaging-core/aws/sqsClient");
const { uploadMarketingAsset } = require("./assetUpload");
const marketingMessageRepository = require("./messageRepository");
const suppressionService = require("./suppressionService");
const contactService = require("../../contacts/service");
const queueJobs = require("../../queueJobs/service");
const deliveryWindow = require("./deliveryWindow");
const dripService = require("./dripService");
const { requireMarketingSender } = require("../../messaging-core/providers/domainSenderResolver");
const { assertMarketingWorkerOnline } = require("./sqsWorkerVerificationService");

// ── Helpers ─────────────────────────────────────────────────────────

function requireLocation(locationId) {
  if (!locationId) {
    const err = new Error("locationId is required");
    err.statusCode = 400;
    throw err;
  }
  return Number(locationId);
}

function notFound(label) {
  const err = new Error(`${label} not found`);
  err.statusCode = 404;
  return err;
}

function validate(rules) {
  const errors = rules.filter(Boolean);
  if (errors.length) {
    const err = new Error(errors[0].message || "Validation failed");
    err.statusCode = 400;
    err.errors = errors;
    throw err;
  }
}

const VALID_EDITOR_TYPES = ["design", "code", "plain"];
const VALID_TEMPLATE_USE_CASES = ["marketing"];
const VALID_FOLDER_KINDS = ["campaign", "template"];
const VALID_CAMPAIGN_STATUSES = ["draft", "scheduled", "sending", "sent", "paused", "failed", "cancelled"];
const VALID_ASSET_TYPES = ["image", "logo", "background", "social", "other"];
const VALID_SNIPPET_TYPES = ["section", "block"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getTemplateBuilderCatalog() {
  return getBuilderCatalog();
}

function normalizeRecipients(input) {
  const list = Array.isArray(input) ? input : [];
  return list
    .map((item) => {
      if (typeof item === "string") return { email: item.trim(), data: {} };
      if (!item || typeof item !== "object") return null;
      return {
        email: String(item.email || item.recipient || "").trim(),
        data: item.data && typeof item.data === "object" ? item.data : {},
        subject: item.subject ? String(item.subject) : undefined,
      };
    })
    .filter((item) => item && EMAIL_RE.test(item.email));
}

function recipientEmail(item) {
  if (typeof item === "string") return item.trim();
  if (!item || typeof item !== "object") return "";
  return String(item.email || item.recipient || "").trim();
}

function collectDesignBlocks(designJson) {
  return (designJson?.sections || []).flatMap((section) =>
    (section.columns || []).flatMap((column) => column.blocks || [])
  );
}

function templateText(template) {
  if (!template) return "";
  if (template.editorType === "design") {
    return collectDesignBlocks(template.designJson || {})
      .map((block) => [block.type, block.content, JSON.stringify(block.settings || {})].filter(Boolean).join(" "))
      .join(" ");
  }
  return [template.htmlBody, template.plainText].filter(Boolean).join(" ");
}

function analyzeTemplateCompliance(template) {
  const text = templateText(template);
  const blocks = template?.editorType === "design" ? collectDesignBlocks(template.designJson || {}) : [];
  const hasFooterBlock = blocks.some((block) => block.type === "footer");
  const usesRuntimeUnsubscribe = /\{\{\s*unsubscribeUrl\s*\}\}/i.test(text);
  const hasStaticUnsubscribe = /href=["'][^"']*(unsubscribe|subscription|preferences)[^"']*["']/i.test(text);
  const hasUnsubscribeTextLink = /unsubscribe/i.test(text) && /href=/i.test(text);
  const hasUnsubscribeLink = usesRuntimeUnsubscribe || hasStaticUnsubscribe || hasUnsubscribeTextLink;
  const hasRuntimeUrlBase = Boolean(config.urls.trackingBaseUrl || config.urls.publicBaseUrl);
  return {
    hasFooterBlock,
    hasUnsubscribeLink,
    usesRuntimeUnsubscribe,
    hasRuntimeUrlBase,
    ok: hasUnsubscribeLink && (!usesRuntimeUnsubscribe || hasRuntimeUrlBase),
  };
}

const MERGE_TAG_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
const RUNTIME_MERGE_TAGS = new Set(["unsubscribeUrl", "viewInBrowserUrl"]);

function stripHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function serializeAudienceJob(row) {
  if (!row) return null;
  const data = row.get ? row.get({ plain: true }) : row;
  return {
    id: data.id,
    locationId: data.locationId,
    campaignId: data.campaignId,
    templateId: data.templateId,
    audience: data.audience || {},
    sendOptions: data.sendOptions || {},
    status: data.status,
    totalTargeted: data.totalTargeted,
    processedCount: data.processedCount || 0,
    queuedCount: data.queuedCount || 0,
    suppressedCount: data.suppressedCount || 0,
    duplicateCount: data.duplicateCount || 0,
    ineligibleCount: data.ineligibleCount || 0,
    failedCount: data.failedCount || 0,
    lastContactId: data.lastContactId || null,
    errors: data.errors || [],
    startedAt: data.startedAt,
    completedAt: data.completedAt,
    lastError: data.lastError,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
}

function extractMergeTags(value) {
  const tags = [];
  const text = String(value || "");
  let match;
  while ((match = MERGE_TAG_RE.exec(text))) tags.push(match[1]);
  return unique(tags);
}

function pathExists(obj, path) {
  if (!obj || typeof obj !== "object") return false;
  return String(path || "")
    .split(".")
    .every((key, index, parts) => {
      const parent = parts.slice(0, index).reduce((acc, part) => (acc && acc[part] !== undefined ? acc[part] : undefined), obj);
      return parent && Object.prototype.hasOwnProperty.call(parent, key) && parent[key] !== undefined && parent[key] !== null;
    });
}

// Org-level {{business.*}} defaults from config, with only non-empty values so
// an unset field (e.g. address) still surfaces as a legitimate preflight warning.
// Per-campaign body.data.business overrides these.
function mergeBusinessDefaults(data = {}) {
  const defaults = {};
  for (const [key, value] of Object.entries(config.business || {})) {
    if (value) defaults[key] = value;
  }
  const provided = data.business && typeof data.business === "object" ? data.business : {};
  const business = { ...defaults, ...provided };
  return Object.keys(business).length ? { ...data, business } : data;
}

function sampleMergeData({ recipients = [], data = {} } = {}) {
  const recipient = recipients[0] || {};
  const recipientData = recipient.data && typeof recipient.data === "object" ? recipient.data : {};
  const contact = {
    email: recipient.email || "",
    ...(data.contact && typeof data.contact === "object" ? data.contact : {}),
    ...(recipientData.contact && typeof recipientData.contact === "object" ? recipientData.contact : {}),
  };
  return {
    ...data,
    ...recipientData,
    contact,
    unsubscribeUrl: "https://example.test/unsubscribe",
    viewInBrowserUrl: "https://example.test/view",
  };
}

function collectHtmlUrls(text) {
  const urls = [];
  const html = String(text || "");
  const attrRe = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  const cssUrlRe = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  let match;
  while ((match = attrRe.exec(html))) urls.push({ url: match[1], field: "html" });
  while ((match = cssUrlRe.exec(html))) urls.push({ url: match[1], field: "css" });
  return urls;
}

function collectValueUrls(value, field = "") {
  if (Array.isArray(value)) return value.flatMap((item, index) => collectValueUrls(item, `${field}.${index}`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => {
    const nextField = field ? `${field}.${key}` : key;
    if (typeof nested === "string" && /(href|url|src|image|poster|feed)/i.test(key)) {
      return [{ url: nested, field: nextField }];
    }
    return collectValueUrls(nested, nextField);
  });
}

function normalizeUrlValue(value) {
  return String(value || "").trim();
}

function isRuntimeUrl(value) {
  return /\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}/.test(String(value || ""));
}

function isDangerousUrl(value) {
  const url = normalizeUrlValue(value).toLowerCase();
  return /^(javascript|vbscript):/.test(url) || /^data:(text\/html|application\/javascript|text\/javascript)/.test(url);
}

function isPlaceholderUrl(value) {
  const url = normalizeUrlValue(value).toLowerCase();
  if (!url || url === "#") return true;
  return /example\.(com|test|org)|yourdomain|placeholder|change-me|changeme|todo/.test(url);
}

function isUnsupportedEmailUrl(value) {
  const url = normalizeUrlValue(value);
  if (!url || isRuntimeUrl(url) || url === "#") return false;
  return !/^(https?:|mailto:|tel:)/i.test(url);
}

function isHttpImageUrl(value) {
  return /^http:\/\//i.test(normalizeUrlValue(value));
}

function addTemplateCheck(checks, key, ok, message, severity = "error", meta = {}) {
  checks.push({ key, ok, message, severity, ...meta });
}

function templatePlainContent(template) {
  if (!template) return "";
  if (template.editorType === "design") {
    return collectDesignBlocks(template.designJson || {})
      .map((block) => stripHtml([block.content, block.settings?.title, block.settings?.subtitle].filter(Boolean).join(" ")))
      .join(" ");
  }
  return stripHtml([template.htmlBody, template.plainText].filter(Boolean).join(" "));
}

function validateTemplateBeforeSend(template, { subject, recipients = [], data = {} } = {}) {
  const checks = [];
  const warnings = [];
  const errors = [];
  const blocks = template?.editorType === "design" ? collectDesignBlocks(template.designJson || {}) : [];
  const sections = template?.editorType === "design" && Array.isArray(template.designJson?.sections) ? template.designJson.sections : [];
  const text = [subject, templateText(template)].filter(Boolean).join(" ");
  const plainContent = templatePlainContent(template);

  const pushIssue = (key, message, severity = "warning", meta = {}) => {
    const issue = { key, message, severity, ...meta };
    if (severity === "error") errors.push(issue);
    else warnings.push(issue);
    addTemplateCheck(checks, key, false, message, severity, meta);
  };

  try {
    if (template?.editorType === "design") validateDesign(template.designJson || {});
  } catch (err) {
    pushIssue("templateSchema", err.message || "Template design schema is invalid.", "error");
  }

  if (!plainContent && !blocks.some((block) => ["image", "logo", "video", "products", "shopping_cart"].includes(block.type))) {
    pushIssue("templateContent", "Template body is empty. Add text, image, button, or footer content before sending.", "error");
  } else if (/start from scratch|write your text here|click here/i.test(plainContent)) {
    pushIssue("placeholderCopy", "Template still contains starter placeholder copy. Review it before real send.", "warning");
  } else {
    addTemplateCheck(checks, "templateContent", true, "Template has body content.", "info");
  }

  const mergeTags = extractMergeTags(text);
  const mergeData = sampleMergeData({ recipients, data });
  const missingTags = mergeTags.filter((tag) => !RUNTIME_MERGE_TAGS.has(tag) && !pathExists(mergeData, tag));
  if (missingTags.length) {
    pushIssue(
      "mergeTags",
      `Sample data is missing merge tag values: ${missingTags.slice(0, 6).join(", ")}${missingTags.length > 6 ? "…" : ""}.`,
      "warning",
      { tags: missingTags }
    );
  } else {
    addTemplateCheck(checks, "mergeTags", true, mergeTags.length ? "Merge tags resolve with current sample data." : "No custom merge tags found.", "info");
  }

  const designUrls = template?.editorType === "design" ? collectValueUrls(template.designJson || {}) : [];
  const htmlUrls = collectHtmlUrls([
    template.htmlBody,
    template.plainText,
    template?.editorType === "design" ? templateText(template) : "",
  ].filter(Boolean).join(" "));
  const urls = [...designUrls, ...htmlUrls].filter((item) => normalizeUrlValue(item.url) && !isRuntimeUrl(item.url));
  const dangerousUrls = urls.filter((item) => isDangerousUrl(item.url));
  const unsupportedUrls = urls.filter((item) => isUnsupportedEmailUrl(item.url));
  const placeholderUrls = urls.filter((item) => isPlaceholderUrl(item.url));
  if (dangerousUrls.length) {
    pushIssue("unsafeUrls", "Template contains unsafe javascript/data URLs. Replace them before sending.", "error", {
      urls: dangerousUrls.slice(0, 5),
    });
  } else if (unsupportedUrls.length) {
    pushIssue("unsupportedUrls", "Some links are relative or unsupported for email. Use full https, mailto, or tel URLs.", "warning", {
      urls: unsupportedUrls.slice(0, 5),
    });
  } else {
    addTemplateCheck(checks, "safeUrls", true, "Links use email-safe protocols.", "info");
  }
  if (placeholderUrls.length) {
    pushIssue("placeholderUrls", "Some links still look like placeholders (#, example.com, or TODO).", "warning", {
      urls: placeholderUrls.slice(0, 5),
    });
  }

  const imageBlocks = blocks.filter((block) => ["image", "logo"].includes(block.type));
  const missingImages = imageBlocks.filter((block) => !normalizeUrlValue(block.settings?.src || block.src));
  const missingAlt = imageBlocks.filter((block) => normalizeUrlValue(block.settings?.src || block.src) && !normalizeUrlValue(block.settings?.alt));
  const insecureImages = urls.filter((item) => /(src|image|poster)/i.test(item.field) && isHttpImageUrl(item.url));
  if (missingImages.length) {
    pushIssue("missingImages", `${missingImages.length} image/logo block${missingImages.length === 1 ? "" : "s"} have no image URL.`, "warning");
  }
  if (missingAlt.length) {
    pushIssue("imageAlt", `${missingAlt.length} image/logo block${missingAlt.length === 1 ? " is" : "s are"} missing alt text.`, "warning");
  }
  if (insecureImages.length) {
    pushIssue("imageHttps", "Some image URLs use http. Use https for better inbox rendering.", "warning", {
      urls: insecureImages.slice(0, 5),
    });
  }
  if (!missingImages.length && !missingAlt.length && !insecureImages.length) {
    addTemplateCheck(checks, "images", true, imageBlocks.length ? "Image blocks have URLs and alt text." : "No required image fixes found.", "info");
  }

  const nonStackingSections = sections.filter((section) => (section.columns || []).length > 1 && section.settings?.mobileStack === false);
  if (nonStackingSections.length) {
    pushIssue("mobileStacking", "A multi-column section has mobile stacking disabled. Verify it in mobile preview before sending.", "warning");
  } else {
    addTemplateCheck(checks, "mobileReady", true, "Multi-column sections are mobile stackable by default.", "info");
  }

  return {
    ok: errors.length === 0,
    checks,
    warnings,
    errors,
  };
}

async function findExistingCampaignRecipient(campaignId, email) {
  const { CrmMarketingMessage } = getModels();
  return CrmMarketingMessage.findOne({
    where: {
      campaignId,
      recipient: { [Op.iLike]: email },
      status: { [Op.notIn]: ["failed", "cancelled"] },
    },
    order: [["createdAt", "DESC"]],
  });
}

// ── Folders ─────────────────────────────────────────────────────────

function serializeFolder(row) {
  return {
    id: row.id,
    locationId: row.locationId,
    name: row.name,
    parentId: row.parentId,
    kind: row.kind,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function listFolders({ locationId, kind, parentId } = {}) {
  const loc = requireLocation(locationId);
  const { CrmMarketingFolder } = getModels();
  const where = { locationId: loc };
  if (kind) where.kind = kind;
  if (parentId === "null" || parentId === null || parentId === undefined) {
    where.parentId = null;
  } else if (parentId) {
    where.parentId = parentId;
  }
  const rows = await CrmMarketingFolder.findAll({
    where,
    order: [["name", "ASC"]],
  });
  return rows.map(serializeFolder);
}

async function createFolder({ locationId, name, kind, parentId } = {}) {
  const loc = requireLocation(locationId);
  validate([
    !name && { field: "name", message: "Folder name is required." },
    !VALID_FOLDER_KINDS.includes(kind) && {
      field: "kind",
      message: `Folder kind must be one of: ${VALID_FOLDER_KINDS.join(", ")}.`,
    },
  ]);
  const { CrmMarketingFolder } = getModels();
  const row = await CrmMarketingFolder.create({
    locationId: loc,
    name: String(name).trim(),
    kind,
    parentId: parentId || null,
  });
  return serializeFolder(row);
}

async function deleteFolder(id) {
  const { CrmMarketingFolder, CrmMarketingTemplate, CrmMarketingCampaign, CrmMarketingAsset } = getModels();
  const row = await CrmMarketingFolder.findByPk(id);
  if (!row) throw notFound("Folder");
  const snapshot = serializeFolder(row);
  // Detach children — don't cascade-delete user content.
  await CrmMarketingTemplate.update({ folderId: null }, { where: { folderId: row.id } });
  await CrmMarketingCampaign.update({ folderId: null }, { where: { folderId: row.id } });
  await CrmMarketingAsset.update({ folderId: null }, { where: { folderId: row.id } });
  await CrmMarketingFolder.update({ parentId: null }, { where: { parentId: row.id } });
  await row.destroy();
  return snapshot;
}

// ── Assets ─────────────────────────────────────────────────────────

function safeAssetUrl(value) {
  const url = String(value || "").trim();
  if (/^https?:\/\//i.test(url)) return url;
  return "";
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 12);
  if (typeof tags === "string") return tags.split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 12);
  return [];
}

function serializeAsset(row) {
  return {
    id: row.id,
    locationId: row.locationId,
    folderId: row.folderId,
    name: row.name,
    assetType: row.assetType,
    url: row.url,
    thumbnailUrl: row.thumbnailUrl,
    altText: row.altText,
    tags: row.tags || [],
    width: row.width,
    height: row.height,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    source: row.source,
    createdByUserId: row.createdByUserId,
    createdByName: row.createdByName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function listAssets({ locationId, folderId, assetType, q, tag, limit = 80 } = {}) {
  const loc = requireLocation(locationId);
  const { CrmMarketingAsset } = getModels();
  const where = { locationId: loc };
  if (folderId && folderId !== "all") where.folderId = folderId === "null" ? null : folderId;
  if (assetType && assetType !== "all") where.assetType = assetType;
  if (q) where.name = { [Op.iLike]: `%${q}%` };
  if (tag) where.tags = { [Op.contains]: [String(tag)] };
  const rows = await CrmMarketingAsset.findAll({
    where,
    order: [["updatedAt", "DESC"]],
    limit: Math.min(Number(limit) || 80, 200),
  });
  return { items: rows.map(serializeAsset) };
}

async function createAsset({ locationId, name, assetType = "image", url, thumbnailUrl, altText, tags, folderId, width, height, mimeType, sizeBytes, user } = {}) {
  const loc = requireLocation(locationId);
  const safeUrl = safeAssetUrl(url);
  validate([
    !name && { field: "name", message: "Asset name is required." },
    !VALID_ASSET_TYPES.includes(assetType) && {
      field: "assetType",
      message: `Asset type must be one of: ${VALID_ASSET_TYPES.join(", ")}.`,
    },
    !safeUrl && { field: "url", message: "Asset URL must start with http:// or https://." },
  ]);
  const { CrmMarketingAsset } = getModels();
  const row = await CrmMarketingAsset.create({
    locationId: loc,
    folderId: folderId || null,
    name: String(name).trim(),
    assetType,
    url: safeUrl,
    thumbnailUrl: safeAssetUrl(thumbnailUrl) || safeUrl,
    altText: altText || "",
    tags: normalizeTags(tags),
    width: width ? Number(width) : null,
    height: height ? Number(height) : null,
    mimeType: mimeType || null,
    sizeBytes: sizeBytes ? Number(sizeBytes) : null,
    source: "url",
    createdByUserId: user?.user_id || null,
    createdByName: user?.name || null,
  });
  return serializeAsset(row);
}

async function uploadAsset({ locationId, name, assetType = "image", fileName, dataUrl, altText, tags, folderId, user } = {}) {
  const loc = requireLocation(locationId);
  const uploaded = await uploadMarketingAsset({ locationId: loc, fileName, dataUrl });
  return createAsset({
    locationId: loc,
    name: name || fileName || "Uploaded image",
    assetType: assetType === "background" ? "image" : assetType,
    url: uploaded.url,
    thumbnailUrl: uploaded.url,
    altText,
    tags,
    folderId,
    width: uploaded.width,
    height: uploaded.height,
    mimeType: uploaded.mimeType,
    sizeBytes: uploaded.sizeBytes,
    user,
  });
}

async function updateAsset(id, body = {}) {
  const { CrmMarketingAsset } = getModels();
  const row = await CrmMarketingAsset.findByPk(id);
  if (!row) throw notFound("Asset");
  const nextUrl = body.url === undefined ? row.url : safeAssetUrl(body.url);
  if (body.url !== undefined && !nextUrl) validate([{ field: "url", message: "Asset URL must start with http:// or https://." }]);
  if (body.assetType && !VALID_ASSET_TYPES.includes(body.assetType)) {
    validate([{ field: "assetType", message: `Asset type must be one of: ${VALID_ASSET_TYPES.join(", ")}.` }]);
  }
  await row.update({
    name: body.name ?? row.name,
    folderId: body.folderId === null ? null : body.folderId ?? row.folderId,
    assetType: body.assetType ?? row.assetType,
    url: nextUrl,
    thumbnailUrl: body.thumbnailUrl === undefined ? row.thumbnailUrl : safeAssetUrl(body.thumbnailUrl) || nextUrl,
    altText: body.altText ?? row.altText,
    tags: body.tags === undefined ? row.tags : normalizeTags(body.tags),
    width: body.width === undefined ? row.width : body.width ? Number(body.width) : null,
    height: body.height === undefined ? row.height : body.height ? Number(body.height) : null,
    mimeType: body.mimeType ?? row.mimeType,
    sizeBytes: body.sizeBytes === undefined ? row.sizeBytes : body.sizeBytes ? Number(body.sizeBytes) : null,
  });
  return serializeAsset(row);
}

async function deleteAsset(id) {
  const { CrmMarketingAsset } = getModels();
  const row = await CrmMarketingAsset.findByPk(id);
  if (!row) throw notFound("Asset");
  const snapshot = serializeAsset(row);
  await row.destroy();
  return snapshot;
}

// ── Saved Sections / Blocks ────────────────────────────────────────

function serializeSnippet(row) {
  return {
    id: row.id,
    locationId: row.locationId,
    name: row.name,
    snippetType: row.snippetType,
    category: row.category,
    tags: row.tags || [],
    previewText: row.previewText,
    designJson: row.designJson,
    createdByUserId: row.createdByUserId,
    createdByName: row.createdByName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function previewFromDesign(snippetType, designJson) {
  if (snippetType === "block") return String(designJson?.content || designJson?.type || "Block").slice(0, 280);
  const firstBlock = (designJson?.columns || []).flatMap((column) => column.blocks || [])[0];
  return String(firstBlock?.content || firstBlock?.type || "Section").replace(/<[^>]+>/g, "").slice(0, 280);
}

async function listSnippets({ locationId, snippetType, category, q, tag, limit = 100 } = {}) {
  const loc = requireLocation(locationId);
  const { CrmMarketingSnippet } = getModels();
  const where = { locationId: loc };
  if (snippetType && snippetType !== "all") where.snippetType = snippetType;
  if (category && category !== "all") where.category = category;
  if (q) where.name = { [Op.iLike]: `%${q}%` };
  if (tag) where.tags = { [Op.contains]: [String(tag)] };
  const rows = await CrmMarketingSnippet.findAll({
    where,
    order: [["updatedAt", "DESC"]],
    limit: Math.min(Number(limit) || 100, 250),
  });
  return { items: rows.map(serializeSnippet) };
}

async function createSnippet({ locationId, name, snippetType, category = "custom", tags, designJson, previewText, user } = {}) {
  const loc = requireLocation(locationId);
  validate([
    !name && { field: "name", message: "Snippet name is required." },
    !VALID_SNIPPET_TYPES.includes(snippetType) && {
      field: "snippetType",
      message: `Snippet type must be one of: ${VALID_SNIPPET_TYPES.join(", ")}.`,
    },
    !designJson || typeof designJson !== "object"
      ? { field: "designJson", message: "Snippet designJson is required." }
      : null,
  ]);
  const { CrmMarketingSnippet } = getModels();
  const row = await CrmMarketingSnippet.create({
    locationId: loc,
    name: String(name).trim(),
    snippetType,
    category: String(category || "custom").trim(),
    tags: normalizeTags(tags),
    designJson,
    previewText: previewText || previewFromDesign(snippetType, designJson),
    createdByUserId: user?.user_id || null,
    createdByName: user?.name || null,
  });
  return serializeSnippet(row);
}

async function updateSnippet(id, body = {}) {
  const { CrmMarketingSnippet } = getModels();
  const row = await CrmMarketingSnippet.findByPk(id);
  if (!row) throw notFound("Snippet");
  if (body.snippetType && !VALID_SNIPPET_TYPES.includes(body.snippetType)) {
    validate([{ field: "snippetType", message: `Snippet type must be one of: ${VALID_SNIPPET_TYPES.join(", ")}.` }]);
  }
  await row.update({
    name: body.name ?? row.name,
    snippetType: body.snippetType ?? row.snippetType,
    category: body.category ?? row.category,
    tags: body.tags === undefined ? row.tags : normalizeTags(body.tags),
    designJson: body.designJson ?? row.designJson,
    previewText: body.previewText ?? row.previewText,
  });
  return serializeSnippet(row);
}

async function deleteSnippet(id) {
  const { CrmMarketingSnippet } = getModels();
  const row = await CrmMarketingSnippet.findByPk(id);
  if (!row) throw notFound("Snippet");
  const snapshot = serializeSnippet(row);
  await row.destroy();
  return snapshot;
}

// ── Templates ───────────────────────────────────────────────────────

function serializeTemplate(row) {
  return {
    id: row.id,
    locationId: row.locationId,
    folderId: row.folderId,
    name: row.name,
    editorType: row.editorType,
    useCase: row.useCase || "marketing",
    htmlBody: row.htmlBody,
    designJson: row.designJson,
    plainText: row.plainText,
    updatedByUserId: row.updatedByUserId,
    updatedByName: row.updatedByName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serializeRevision(row) {
  return {
    id: row.id,
    templateId: row.templateId,
    locationId: row.locationId,
    revisionNumber: row.revisionNumber,
    name: row.name,
    editorType: row.editorType,
    useCase: row.useCase,
    htmlBody: row.htmlBody,
    designJson: row.designJson,
    plainText: row.plainText,
    updatedByUserId: row.updatedByUserId,
    updatedByName: row.updatedByName,
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

async function createTemplateRevision(row, { user, reason = "save" } = {}) {
  const { CrmMarketingTemplateRevision } = getModels();
  const latest = await CrmMarketingTemplateRevision.max("revisionNumber", {
    where: { templateId: row.id },
  });
  const revision = await CrmMarketingTemplateRevision.create({
    templateId: row.id,
    locationId: row.locationId,
    revisionNumber: Number(latest || 0) + 1,
    name: row.name,
    editorType: row.editorType,
    useCase: row.useCase || "marketing",
    htmlBody: row.htmlBody,
    designJson: row.designJson,
    plainText: row.plainText,
    updatedByUserId: user?.user_id ?? row.updatedByUserId,
    updatedByName: user?.name ?? row.updatedByName,
    reason,
  });
  return serializeRevision(revision);
}

async function listTemplates({ locationId, folderId, q, useCase } = {}) {
  const loc = requireLocation(locationId);
  const { CrmMarketingTemplate } = getModels();
  const where = { locationId: loc };
  if (folderId === "null" || folderId === null || folderId === undefined) {
    where.folderId = null;
  } else {
    where.folderId = folderId;
  }
  if (q) where.name = { [Op.iLike]: `%${q}%` };
  // Marketing table only stores marketing templates. Transactional
  // templates live in crm_transactional_templates (separate API).
  // The useCase column is retained for legacy filtering but new rows
  // are always 'marketing'.
  if (useCase) where.useCase = useCase;
  const rows = await CrmMarketingTemplate.findAll({
    where,
    order: [["updatedAt", "DESC"]],
  });
  return rows.map(serializeTemplate);
}

async function getTemplate(id) {
  const { CrmMarketingTemplate } = getModels();
  const row = await CrmMarketingTemplate.findByPk(id);
  if (!row) throw notFound("Template");
  return serializeTemplate(row);
}

async function createTemplate({ locationId, name, editorType = "design", useCase = "marketing", folderId, htmlBody, designJson, plainText, user } = {}) {
  const loc = requireLocation(locationId);
  validate([
    !name && { field: "name", message: "Template name is required." },
    !VALID_EDITOR_TYPES.includes(editorType) && {
      field: "editorType",
      message: `Editor type must be one of: ${VALID_EDITOR_TYPES.join(", ")}.`,
    },
    !VALID_TEMPLATE_USE_CASES.includes(useCase) && {
      field: "useCase",
      message: `Use case must be one of: ${VALID_TEMPLATE_USE_CASES.join(", ")}.`,
    },
  ]);
  const { CrmMarketingTemplate } = getModels();
  const nextDesignJson = editorType === "design" ? designJson || createDefaultDesign() : designJson || null;
  if (nextDesignJson) validateDesign(nextDesignJson);
  const nextHtmlBody = editorType === "design" && !htmlBody
    ? renderDesign(nextDesignJson, { title: name }).html
    : htmlBody || null;
  const row = await CrmMarketingTemplate.create({
    locationId: loc,
    folderId: folderId || null,
    name: String(name).trim(),
    editorType,
    useCase,
    htmlBody: nextHtmlBody,
    designJson: nextDesignJson,
    plainText: plainText || null,
    updatedByUserId: user?.user_id || null,
    updatedByName: user?.name || null,
  });
  await createTemplateRevision(row, { user, reason: "create" });
  return serializeTemplate(row);
}

async function updateTemplate(id, body = {}, user) {
  const { CrmMarketingTemplate } = getModels();
  const row = await CrmMarketingTemplate.findByPk(id);
  if (!row) throw notFound("Template");
  if (body.editorType && !VALID_EDITOR_TYPES.includes(body.editorType)) {
    validate([{ field: "editorType", message: `Editor type must be one of: ${VALID_EDITOR_TYPES.join(", ")}.` }]);
  }
  if (body.useCase && !VALID_TEMPLATE_USE_CASES.includes(body.useCase)) {
    validate([{ field: "useCase", message: `Use case must be one of: ${VALID_TEMPLATE_USE_CASES.join(", ")}.` }]);
  }
  const nextEditorType = body.editorType ?? row.editorType;
  const nextDesignJson = body.designJson ?? row.designJson;
  if (nextEditorType === "design" && nextDesignJson) validateDesign(nextDesignJson);
  const shouldRenderHtml =
    nextEditorType === "design" &&
    body.htmlBody === undefined &&
    (body.designJson !== undefined || !row.htmlBody);
  const nextHtmlBody = shouldRenderHtml
    ? renderDesign(nextDesignJson || createDefaultDesign(), { title: body.name ?? row.name }).html
    : body.htmlBody ?? row.htmlBody;

  await row.update({
    name: body.name ?? row.name,
    folderId: body.folderId === null ? null : body.folderId ?? row.folderId,
    editorType: nextEditorType,
    useCase: body.useCase ?? row.useCase,
    htmlBody: nextHtmlBody,
    designJson: nextDesignJson,
    plainText: body.plainText ?? row.plainText,
    updatedByUserId: user?.user_id ?? row.updatedByUserId,
    updatedByName: user?.name ?? row.updatedByName,
  });
  await createTemplateRevision(row, { user, reason: body.revisionReason || "save" });
  return serializeTemplate(row);
}

async function listTemplateRevisions(templateId) {
  const { CrmMarketingTemplate, CrmMarketingTemplateRevision } = getModels();
  const template = await CrmMarketingTemplate.findByPk(templateId);
  if (!template) throw notFound("Template");
  const rows = await CrmMarketingTemplateRevision.findAll({
    where: { templateId },
    order: [["revisionNumber", "DESC"]],
  });
  return { items: rows.map(serializeRevision) };
}

async function getTemplateRevision(templateId, revisionId) {
  const { CrmMarketingTemplateRevision } = getModels();
  const row = await CrmMarketingTemplateRevision.findOne({ where: { id: revisionId, templateId } });
  if (!row) throw notFound("Revision");
  return serializeRevision(row);
}

async function restoreTemplateRevision(templateId, revisionId, user) {
  const { CrmMarketingTemplate, CrmMarketingTemplateRevision } = getModels();
  const template = await CrmMarketingTemplate.findByPk(templateId);
  if (!template) throw notFound("Template");
  const revision = await CrmMarketingTemplateRevision.findOne({ where: { id: revisionId, templateId } });
  if (!revision) throw notFound("Revision");
  await template.update({
    name: revision.name,
    editorType: revision.editorType,
    useCase: revision.useCase,
    htmlBody: revision.htmlBody,
    designJson: revision.designJson,
    plainText: revision.plainText,
    updatedByUserId: user?.user_id ?? template.updatedByUserId,
    updatedByName: user?.name ?? template.updatedByName,
  });
  await createTemplateRevision(template, { user, reason: `restore:${revision.revisionNumber}` });
  return serializeTemplate(template);
}

async function renderTemplate(id, { data } = {}) {
  const template = await getTemplate(id);
  if (template.editorType === "design") {
    const rendered = renderDesign(template.designJson || createDefaultDesign(), {
      title: template.name,
      data: data || {},
    });
    return {
      editorType: template.editorType,
      htmlBody: rendered.html,
      designJson: rendered.design,
    };
  }
  return {
    editorType: template.editorType,
    ...renderRawTemplate({ ...template, data: data || {} }),
  };
}

function renderDraftTemplate({ name = "Draft email", designJson, htmlBody, plainText, editorType = "design", data } = {}) {
  if (editorType === "code" || editorType === "plain") {
    return {
      editorType,
      ...renderRawTemplate({ editorType, htmlBody, plainText, data: data || {} }),
    };
  }
  if (designJson) validateDesign(designJson);
  const rendered = renderDesign(designJson || createDefaultDesign(), {
    title: name,
    data: data || {},
  });
  return {
    editorType: "design",
    htmlBody: rendered.html,
    designJson: rendered.design,
  };
}

async function sendTestTemplate(id, { to, subject, data, from } = {}) {
  validate([
    !EMAIL_RE.test(String(to || "").trim()) && { field: "to", message: "Valid test recipient email is required." },
  ]);
  const template = await getTemplate(id);
  const templateValidation = validateTemplateBeforeSend(template, {
    subject: subject || `[Test] ${template.name}`,
    recipients: [{ email: String(to).trim(), data: data || {} }],
    data: data || {},
  });
  validate(templateValidation.errors.map((issue) => ({ field: issue.key, message: issue.message })));
  const htmlBody = template.editorType === "design"
    ? renderDesign(template.designJson || createDefaultDesign(), { title: template.name, data: data || {} }).html
    : renderRawTemplate({ ...template, data: data || {} }).htmlBody;
  const send = template.useCase === "transactional"
    ? emailProvider.sendTransactionalEmail
    : emailProvider.sendMarketingEmail;
  const result = await send({
    locationId: template.locationId,
    to: String(to).trim(),
    subject: interpolate(subject || `[Test] ${template.name}`, data || {}),
    html: htmlBody,
    text: template.editorType === "design" ? undefined : renderRawTemplate({ ...template, data: data || {} }).plainText,
    from,
    trackingTags: [
      { name: "purpose", value: "test_send" },
      { name: "template_id", value: template.id },
    ],
  });
  return {
    ok: true,
    to: String(to).trim(),
    subject: subject || `[Test] ${template.name}`,
    useCase: template.useCase,
    provider: result.provider,
    providerMessageId: result.providerMessageId,
  };
}

async function sendTestDraftTemplate({ to, subject, name = "Draft email", useCase = "marketing", editorType = "design", designJson, htmlBody, plainText, data, from, locationId } = {}) {
  const nextEditorType = VALID_EDITOR_TYPES.includes(editorType) ? editorType : "design";
  validate([
    !EMAIL_RE.test(String(to || "").trim()) && { field: "to", message: "Valid test recipient email is required." },
    !subject && { field: "subject", message: "Subject is required for test send." },
    nextEditorType === "design" && !(designJson && typeof designJson === "object") && { field: "designJson", message: "designJson is required." },
    nextEditorType === "code" && !String(htmlBody || "").trim() && { field: "htmlBody", message: "HTML body is required." },
    nextEditorType === "plain" && !String(plainText || "").trim() && { field: "plainText", message: "Plain text body is required." },
  ]);
  if (designJson) validateDesign(designJson);
  const rawContent = renderRawTemplate({ editorType: nextEditorType, htmlBody, plainText, data: data || {} });
  const renderedHtml = nextEditorType === "design"
    ? renderDesign(designJson || createDefaultDesign(), { title: name, data: data || {} }).html
    : rawContent.htmlBody;
  const templateValidation = validateTemplateBeforeSend({
    name,
    editorType: nextEditorType,
    useCase,
    designJson: nextEditorType === "design" ? designJson : null,
    htmlBody: nextEditorType === "code" ? htmlBody : null,
    plainText: nextEditorType === "design" ? null : plainText,
  }, {
    subject,
    recipients: [{ email: String(to).trim(), data: data || {} }],
    data: data || {},
  });
  validate(templateValidation.errors.map((issue) => ({ field: issue.key, message: issue.message })));
  const send = useCase === "transactional"
    ? emailProvider.sendTransactionalEmail
    : emailProvider.sendMarketingEmail;
  const result = await send({
    locationId: locationId || null,
    to: String(to).trim(),
    subject: interpolate(subject, data || {}),
    html: renderedHtml,
    text: nextEditorType === "design" ? undefined : rawContent.plainText,
    from,
    trackingTags: [{ name: "purpose", value: "draft_test_send" }],
  });
  return {
    ok: true,
    to: String(to).trim(),
    subject,
    useCase,
    provider: result.provider,
    providerMessageId: result.providerMessageId,
  };
}

async function deleteTemplate(id) {
  const { CrmMarketingTemplate, CrmMarketingCampaign } = getModels();
  const row = await CrmMarketingTemplate.findByPk(id);
  if (!row) throw notFound("Template");
  const snapshot = serializeTemplate(row);
  // Don't break campaigns that reference this template — null the link.
  await CrmMarketingCampaign.update({ templateId: null }, { where: { templateId: row.id } });
  await row.destroy();
  return snapshot;
}

// ── Campaigns ───────────────────────────────────────────────────────

function serializeCampaign(row) {
  return {
    id: row.id,
    locationId: row.locationId,
    folderId: row.folderId,
    name: row.name,
    channel: row.channel,
    campaignType: row.campaignType,
    templateId: row.templateId,
    status: row.status,
    scheduledAt: row.scheduledAt,
    executionDate: row.executionDate,
    dripSteps: row.dripSteps || [],
    metrics: {
      recipients: row.totalRecipients,
      delivered: row.totalDelivered,
      opened: row.totalOpened,
      clicked: row.totalClicked,
      bounced: row.totalBounced,
      unsubscribed: row.totalUnsubscribed,
      complained: row.totalComplained,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serializeMessage(row) {
  return {
    id: row.id,
    locationId: row.locationId,
    campaignId: row.campaignId,
    templateId: row.templateId,
    channel: row.channel,
    recipient: row.recipient,
    subject: row.subject,
    status: row.status,
    provider: row.provider,
    providerMessageId: row.providerMessageId,
    metadata: row.metadata || {},
    queuedAt: row.queuedAt,
    sentAt: row.sentAt,
    deliveredAt: row.deliveredAt,
    openedAt: row.openedAt,
    clickedAt: row.clickedAt,
    bouncedAt: row.bouncedAt,
    complainedAt: row.complainedAt,
    unsubscribedAt: row.unsubscribedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serializeDeliveryEvent(row) {
  return {
    id: row.id,
    messageId: row.messageId,
    campaignId: row.campaignId,
    provider: row.provider,
    providerMessageId: row.providerMessageId,
    eventType: row.eventType,
    payload: row.payload || {},
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
  };
}

function messageFailureReason(row) {
  const metadata = row?.metadata || {};
  return metadata.lastError || metadata.error || metadata.retryError || "Unknown failure";
}

function failureGroupKey(reason) {
  return String(reason || "Unknown failure")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "{uuid}")
    .replace(/\b\d{4,}\b/g, "{number}")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "Unknown failure";
}

function serializeFailedMessage(row) {
  return {
    ...serializeMessage(row),
    campaign: row.campaign ? serializeCampaign(row.campaign) : null,
    lastError: messageFailureReason(row),
    failureGroup: failureGroupKey(messageFailureReason(row)),
    retryCount: Number(row.metadata?.retryCount || 0),
    lastRetryAt: row.metadata?.lastRetryAt || null,
    failedAt: row.metadata?.failedAt || null,
  };
}

async function listCampaigns({ locationId, folderId, campaignType, q, status, page = 1, pageSize = 10 } = {}) {
  const loc = requireLocation(locationId);
  const { CrmMarketingCampaign } = getModels();
  const where = { locationId: loc };
  if (folderId === "null" || folderId === null || folderId === undefined) {
    where.folderId = null;
  } else {
    where.folderId = folderId;
  }
  if (campaignType) where.campaignType = campaignType;
  if (status) where.status = status;
  if (q) where.name = { [Op.iLike]: `%${q}%` };

  const limit = Math.min(100, Math.max(1, Number(pageSize) || 10));
  const offset = Math.max(0, (Number(page) - 1) * limit);
  const { rows, count } = await CrmMarketingCampaign.findAndCountAll({
    where,
    order: [["updatedAt", "DESC"]],
    limit,
    offset,
  });
  return {
    items: rows.map(serializeCampaign),
    total: count,
    page: Number(page) || 1,
    pageSize: limit,
  };
}

async function listCampaignMessages(campaignId, { q, status, page = 1, pageSize = 25 } = {}) {
  const { CrmMarketingCampaign, CrmMarketingMessage } = getModels();
  const campaign = await CrmMarketingCampaign.findByPk(campaignId);
  if (!campaign) throw notFound("Campaign");

  const where = { campaignId };
  if (status) where.status = status;
  if (q) {
    where[Op.or] = [
      { recipient: { [Op.iLike]: `%${q}%` } },
      { subject: { [Op.iLike]: `%${q}%` } },
      { providerMessageId: { [Op.iLike]: `%${q}%` } },
    ];
  }

  const limit = Math.min(100, Math.max(1, Number(pageSize) || 25));
  const offset = Math.max(0, (Number(page) - 1) * limit);
  const { rows, count } = await CrmMarketingMessage.findAndCountAll({
    where,
    order: [["createdAt", "DESC"]],
    limit,
    offset,
  });

  return {
    campaign: serializeCampaign(campaign),
    items: rows.map(serializeMessage),
    total: count,
    page: Number(page) || 1,
    pageSize: limit,
  };
}

async function listMessageEvents(messageId) {
  const { CrmMarketingMessage, CrmMarketingDeliveryEvent } = getModels();
  const message = await CrmMarketingMessage.findByPk(messageId);
  if (!message) throw notFound("Marketing message");
  const rows = await CrmMarketingDeliveryEvent.findAll({
    where: { messageId },
    order: [["occurredAt", "DESC"]],
    limit: 100,
  });
  return {
    message: serializeMessage(message),
    items: rows.map(serializeDeliveryEvent),
  };
}

async function listFailedMessages({ locationId, campaignId, q, failureGroup, page = 1, pageSize = 25 } = {}) {
  const loc = requireLocation(locationId);
  const { CrmMarketingCampaign, CrmMarketingMessage } = getModels();
  const where = { locationId: loc, status: "failed" };
  if (campaignId) where.campaignId = campaignId;
  if (q) {
    where[Op.or] = [
      { recipient: { [Op.iLike]: `%${q}%` } },
      { subject: { [Op.iLike]: `%${q}%` } },
      { providerMessageId: { [Op.iLike]: `%${q}%` } },
    ];
  }

  const allFailed = await CrmMarketingMessage.findAll({
    where,
    include: [{ model: CrmMarketingCampaign, as: "campaign", required: false }],
    order: [["updatedAt", "DESC"]],
    limit: 500,
  });
  const groupsMap = new Map();
  for (const row of allFailed) {
    const reason = messageFailureReason(row);
    const key = failureGroupKey(reason);
    const group = groupsMap.get(key) || {
      key,
      reason,
      count: 0,
      latestAt: row.updatedAt,
      sampleRecipients: [],
    };
    group.count += 1;
    if (group.sampleRecipients.length < 3) group.sampleRecipients.push(row.recipient);
    if (new Date(row.updatedAt) > new Date(group.latestAt)) group.latestAt = row.updatedAt;
    groupsMap.set(key, group);
  }

  const filtered = failureGroup
    ? allFailed.filter((row) => failureGroupKey(messageFailureReason(row)) === failureGroup)
    : allFailed;
  const limit = Math.min(100, Math.max(1, Number(pageSize) || 25));
  const currentPage = Math.max(1, Number(page) || 1);
  const offset = (currentPage - 1) * limit;
  const items = filtered.slice(offset, offset + limit);

  return {
    items: items.map(serializeFailedMessage),
    total: filtered.length,
    page: currentPage,
    pageSize: limit,
    groups: Array.from(groupsMap.values()).sort((a, b) => b.count - a.count || new Date(b.latestAt) - new Date(a.latestAt)),
  };
}

async function createCampaign({ locationId, name, folderId, campaignType = "email_campaign", templateId, scheduledAt } = {}) {
  const loc = requireLocation(locationId);
  validate([
    !name && { field: "name", message: "Campaign name is required." },
  ]);
  const { CrmMarketingCampaign } = getModels();
  const row = await CrmMarketingCampaign.create({
    locationId: loc,
    folderId: folderId || null,
    name: String(name).trim(),
    channel: "email",
    campaignType,
    templateId: templateId || null,
    status: scheduledAt ? "scheduled" : "draft",
    scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
  });
  return serializeCampaign(row);
}

async function preflightCampaignMessages(campaignId, body = {}) {
  const { CrmMarketingCampaign, CrmMarketingTemplate } = getModels();
  const campaign = await CrmMarketingCampaign.findByPk(campaignId);
  if (!campaign) throw notFound("Campaign");

  const recipientInput = Array.isArray(body.recipients) ? body.recipients : [];
  const recipients = normalizeRecipients(recipientInput);
  const invalid = recipientInput
    .map((item, index) => ({ index, email: recipientEmail(item) }))
    .filter((item) => !EMAIL_RE.test(item.email));
  const dripSteps = await prepareDripCampaign(campaign, body, { persist: false });
  const templateId = dripSteps?.[0]?.templateId || body.templateId || campaign.templateId;
  const checks = [];
  const businessData = mergeBusinessDefaults(body.data && typeof body.data === "object" ? body.data : {});
  try {
    await requireMarketingSender({ locationId: campaign.locationId, from: body.from });
    checks.push({ key: "sender", ok: true, message: "Active verified marketing sender is available." });
  } catch (error) {
    checks.push({ key: "sender", ok: false, message: error.message });
  }
  checks.push({
    key: "businessAddress",
    ok: Boolean(String(businessData.business?.address || "").trim()),
    message: "A business postal address is required in campaign data.business.address or CRM_BUSINESS_ADDRESS.",
  });
  try {
    assertMarketingQueueConfigured(campaignQueueType(campaign));
    await assertMarketingWorkerOnline({ audience: hasAudienceSelection(body) || campaign.campaignType === "workflow_campaign" });
    checks.push({ key: "queue", ok: true, message: "Marketing queue is configured." });
  } catch (error) {
    checks.push({ key: "queue", ok: false, message: error.message });
  }
  let template = null;
  let templateValidation = null;

  if (!templateId) {
    checks.push({ key: "template", ok: false, message: "Choose a template before queueing." });
  } else {
    template = await CrmMarketingTemplate.findByPk(templateId);
    checks.push({
      key: "template",
      ok: Boolean(template),
      message: template ? "Template found." : "Template was not found.",
    });
    if (template) {
      checks.push({
        key: "useCase",
        ok: template.useCase !== "transactional",
        message: template.useCase === "transactional"
          ? "Transactional templates cannot be used for marketing campaign sends."
          : "Template is allowed for marketing sends.",
      });
      const compliance = analyzeTemplateCompliance(template);
      checks.push({
        key: "unsubscribe",
        ok: compliance.hasUnsubscribeLink,
        message: compliance.hasUnsubscribeLink
          ? "Unsubscribe link is present."
          : "Add a Footer block or an unsubscribe link before queueing marketing email.",
      });
      checks.push({
        key: "trackingBaseUrl",
        ok: !compliance.usesRuntimeUnsubscribe || compliance.hasRuntimeUrlBase,
        message: compliance.usesRuntimeUnsubscribe && !compliance.hasRuntimeUrlBase
          ? "Set CRM_TRACKING_BASE_URL so unsubscribe links render as full URLs."
          : "Public marketing links can be generated.",
      });
      templateValidation = validateTemplateBeforeSend(template, {
        subject: body.subject || campaign.name,
        recipients,
        data: mergeBusinessDefaults(body.data && typeof body.data === "object" ? body.data : {}),
      });
      checks.push(...templateValidation.checks.map((check) => ({
        ...check,
        key: `templateValidation:${check.key}`,
      })));
    }
  }

  checks.push({
    key: "subject",
    ok: Boolean(String(body.subject || campaign.name || "").trim()),
    message: "Subject is present.",
  });
  checks.push({
    key: "recipients",
    ok: recipients.length > 0 && invalid.length === 0,
    message: invalid.length ? "Fix invalid recipient rows." : "Recipients are valid.",
  });
  checks.push({
    key: "batchSize",
    ok: recipients.length <= 500,
    message: recipients.length > 500 ? "Queue at most 500 recipients per request." : "Batch size is within limit.",
  });

  const allowResend = body.allowResend === true;
  const seen = new Set();
  const duplicates = [];
  const suppressed = [];
  const existing = [];
  let uniqueValid = 0;
  for (const recipient of recipients) {
    const key = recipient.email.toLowerCase();
    if (seen.has(key)) {
      duplicates.push({ email: recipient.email });
      continue;
    }
    seen.add(key);
    uniqueValid += 1;
    const suppression = await suppressionService.isSuppressed(campaign.locationId, recipient.email);
    if (suppression) {
      suppressed.push({
        email: recipient.email,
        reason: suppression.reason,
        suppressionId: suppression.id,
      });
      continue;
    }
    if (!allowResend) {
      const existingMessage = await findExistingCampaignRecipient(campaign.id, recipient.email);
      if (existingMessage) {
        existing.push({
          email: recipient.email,
          messageId: existingMessage.id,
          status: existingMessage.status,
        });
      }
    }
  }

  return {
    campaign: serializeCampaign(campaign),
    template: template ? { id: template.id, name: template.name, useCase: template.useCase } : null,
    compliance: template ? analyzeTemplateCompliance(template) : null,
    counts: {
      input: recipientInput.length,
      valid: recipients.length,
      invalid: invalid.length,
      duplicate: duplicates.length,
      suppressed: suppressed.length,
      existing: existing.length,
      queueable: Math.max(0, uniqueValid - suppressed.length - (allowResend ? 0 : existing.length)),
    },
    invalid,
    duplicates,
    suppressed,
    existing,
    allowResend,
    checks,
    templateValidation,
    ok: checks.every((check) => check.ok || check.severity === "warning"),
  };
}

function hasAudienceSelection(body = {}) {
  const audience = body.audience && typeof body.audience === "object" ? body.audience : body;
  return Boolean(
    audience.allowAll
      || audience.segmentId
      || (Array.isArray(audience.segmentIds) && audience.segmentIds.length)
      || audience.filters
      || audience.search
      || (Array.isArray(audience.ids) && audience.ids.length)
      || (Array.isArray(audience.contactIds) && audience.contactIds.length)
  );
}

function normalizeCampaignAudience(body = {}) {
  const raw = body.audience && typeof body.audience === "object" ? body.audience : body;
  const ids = Array.isArray(raw.ids) ? raw.ids : raw.contactIds;
  return {
    segmentId: raw.segmentId || null,
    segmentIds: Array.isArray(raw.segmentIds) ? raw.segmentIds.map((id) => String(id)).filter(Boolean) : [],
    filters: raw.filters || null,
    search: raw.search || "",
    allowAll: raw.allowAll === true,
    ids: Array.isArray(ids) ? ids.map((id) => String(id)).filter(Boolean) : [],
  };
}

function campaignSendOptions(body = {}) {
  const controls = deliveryWindow.normalizeDeliveryControls(body);
  return {
    queueType: body.queueType === "journey" ? "journey" : "bulk",
    allowResend: body.allowResend === true,
    subject: body.subject || null,
    from: body.from || null,
    data: body.data && typeof body.data === "object" ? body.data : {},
    source: body.source || "campaign_audience",
    ...controls,
  };
}

function campaignQueueType(campaign) {
  return campaign?.campaignType === "workflow_campaign" ? "journey" : "bulk";
}

function cleanDripSteps(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 30).map((step, index) => {
    const type = ["email", "wait", "condition"].includes(step?.type) ? step.type : "email";
    if (type === "email") return {
      id: String(step.id || `email_${index + 1}`).slice(0, 80),
      type,
      templateId: step.templateId || null,
      subject: step.subject ? String(step.subject).trim().slice(0, 500) : null,
    };
    if (type === "condition") return {
      id: String(step.id || `condition_${index + 1}`).slice(0, 80),
      type,
      event: step.event === "clicked" ? "clicked" : "opened",
      timeoutAmount: Math.min(365, Math.max(1, Number(step.timeoutAmount) || 1)),
      timeoutUnit: ["minutes", "hours", "days"].includes(step.timeoutUnit) ? step.timeoutUnit : "days",
      onTimeout: step.onTimeout === "stop" ? "stop" : "continue",
    };
    return {
      id: String(step.id || `wait_${index + 1}`).slice(0, 80),
      type,
      amount: Math.min(365, Math.max(1, Number(step.amount) || 1)),
      unit: ["minutes", "hours", "days"].includes(step.unit) ? step.unit : "days",
    };
  });
}

async function prepareDripCampaign(campaign, body = {}, { persist = true } = {}) {
  if (campaign.campaignType !== "workflow_campaign") return null;
  const steps = cleanDripSteps(body.dripSteps?.length ? body.dripSteps : campaign.dripSteps);
  const emailSteps = steps.filter((step) => step.type === "email");
  validate([
    steps.length === 0 && { field: "dripSteps", message: "Add at least two email steps to this drip campaign." },
    steps[0]?.type !== "email" && { field: "dripSteps", message: "A drip campaign must start with an email step." },
    emailSteps.length < 2 && { field: "dripSteps", message: "A drip campaign needs at least two email steps." },
    emailSteps.some((step) => !step.templateId) && { field: "dripSteps", message: "Choose a template for every drip email step." },
  ]);
  const { CrmMarketingTemplate } = getModels();
  const templateIds = Array.from(new Set(emailSteps.map((step) => step.templateId)));
  const templates = await CrmMarketingTemplate.findAll({ where: { id: { [Op.in]: templateIds }, locationId: campaign.locationId } });
  validate([
    templates.length !== templateIds.length && { field: "dripSteps", message: "One or more drip templates are unavailable for this location." },
    templates.some((template) => template.useCase === "transactional") && { field: "dripSteps", message: "Transactional templates cannot be used in a marketing drip." },
    templates.some((template) => !analyzeTemplateCompliance(template).ok) && { field: "dripSteps", message: "Every drip template must contain a valid unsubscribe link." },
  ]);
  if (persist) await campaign.update({ dripSteps: steps, templateId: emailSteps[0].templateId });
  return steps;
}

async function validateCampaignQueueContext(campaign, body = {}, recipients = []) {
  await requireMarketingSender({ locationId: campaign.locationId, from: body.from });
  const { CrmMarketingTemplate } = getModels();
  const templateId = body.templateId || campaign.templateId;
  validate([
    !templateId && { field: "templateId", message: "Choose a template before queueing a campaign." },
  ]);

  const template = await CrmMarketingTemplate.findByPk(templateId);
  if (!template) throw notFound("Template");

  const globalData = mergeBusinessDefaults(body.data && typeof body.data === "object" ? body.data : {});
  const compliance = analyzeTemplateCompliance(template);
  const templateValidation = validateTemplateBeforeSend(template, {
    subject: body.subject || campaign.name,
    recipients,
    data: globalData,
  });
  validate([
    !String(globalData.business?.address || "").trim() && {
      field: "business.address",
      message: "Set your business postal address in campaign data.business.address or CRM_BUSINESS_ADDRESS before sending marketing emails.",
    },
    template.useCase === "transactional" && {
      field: "templateId",
      message: "Transactional templates cannot be used for marketing campaign sends.",
    },
    !compliance.hasUnsubscribeLink && {
      field: "templateId",
      message: "Marketing templates must include an unsubscribe link. Add a Footer block before queueing.",
    },
    compliance.usesRuntimeUnsubscribe && !compliance.hasRuntimeUrlBase && {
      field: "templateId",
      message: "Set CRM_TRACKING_BASE_URL before queueing templates that use {{unsubscribeUrl}}.",
    },
    ...templateValidation.errors.map((issue) => ({
      field: issue.key,
      message: issue.message,
    })),
  ]);

  return { template, templateId, globalData };
}

async function createCampaignAudienceJob(campaign, body = {}) {
  assertMarketingQueueConfigured(campaignQueueType(campaign));
  await assertMarketingWorkerOnline({ audience: true });
  const { CrmMarketingCampaignAudienceJob } = getModels();
  const audience = normalizeCampaignAudience(body);
  validate([
    !audience.allowAll && !audience.segmentId && !audience.segmentIds.length && !audience.filters && !audience.search && !audience.ids.length && {
      field: "audience",
      message: "Choose contacts, a segment, filters, search, or allowAll before queueing a campaign audience.",
    },
  ]);

  const dripSteps = await prepareDripCampaign(campaign, body);
  const effectiveBody = dripSteps ? { ...body, templateId: dripSteps[0].templateId } : body;
  const { templateId } = await validateCampaignQueueContext(campaign, effectiveBody, []);
  const sendOptions = {
    ...campaignSendOptions(body),
    queueType: campaignQueueType(campaign),
    ...(dripSteps ? { dripSteps } : {}),
  };
  const job = await CrmMarketingCampaignAudienceJob.create({
    locationId: campaign.locationId,
    campaignId: campaign.id,
    templateId,
    audience,
    sendOptions,
    status: "queued",
  });
  await campaign.update({
    templateId,
    status: "sending",
    executionDate: campaign.executionDate || new Date(),
  });
  const queueJob = await queueJobs.enqueueJob({
    jobType: queueJobs.JOB_TYPES.MARKETING_CAMPAIGN_AUDIENCE,
    locationId: campaign.locationId,
    priority: 45,
    payload: { campaignAudienceJobId: job.id },
    runAt: deliveryWindow.nextAllowedDeliveryAt(new Date(), sendOptions.deliveryWindow),
  });

  return {
    campaign: serializeCampaign(await campaign.reload()),
    audienceJob: serializeAudienceJob(job),
    queueJob,
    queued: [],
    totalQueued: 0,
    suppressed: [],
    totalSuppressed: 0,
    duplicates: [],
    totalDuplicates: 0,
    existing: [],
    totalExisting: 0,
    allowResend: sendOptions.allowResend,
    queueType: sendOptions.queueType,
    mode: "audience_job",
  };
}

function requestedSchedule(body = {}) {
  if (body._scheduledDispatch === true || !body.scheduledAt) return null;
  const value = new Date(body.scheduledAt);
  validate([
    Number.isNaN(value.getTime()) && { field: "scheduledAt", message: "Choose a valid campaign date and time." },
    !Number.isNaN(value.getTime()) && value.getTime() <= Date.now() && { field: "scheduledAt", message: "Scheduled campaign time must be in the future." },
  ]);
  return value;
}

async function scheduleCampaignDispatch(campaign, body, scheduledAt) {
  const audienceSelected = hasAudienceSelection(body);
  await assertMarketingWorkerOnline({ audience: audienceSelected || campaign.campaignType === "workflow_campaign" });
  const dripSteps = await prepareDripCampaign(campaign, body);
  const templateId = dripSteps?.[0]?.templateId || body.templateId || campaign.templateId;
  const recipients = audienceSelected ? [] : normalizeRecipients(Array.isArray(body.recipients) ? body.recipients : []);
  validate([
    !audienceSelected && recipients.length === 0 && { field: "recipients", message: "Choose an audience or at least one recipient before scheduling." },
    !audienceSelected && recipients.length !== (Array.isArray(body.recipients) ? body.recipients.length : 0) && { field: "recipients", message: "Every scheduled recipient must include a valid email address." },
    !templateId && { field: "templateId", message: "Choose a template before scheduling the campaign." },
  ]);
  await validateCampaignQueueContext(campaign, { ...body, templateId }, recipients);
  const sendRequest = {
    ...body,
    templateId,
    scheduledAt: null,
    _scheduledDispatch: true,
    ...(dripSteps ? { dripSteps } : {}),
  };
  const queueJob = await queueJobs.scheduleUniqueJob({
    dedupeKey: `marketing-campaign-dispatch:${campaign.id}`,
    jobType: queueJobs.JOB_TYPES.MARKETING_CAMPAIGN_DISPATCH,
    locationId: campaign.locationId,
    priority: 40,
    runAt: scheduledAt,
    maxAttempts: 8,
    payload: { campaignId: campaign.id, sendRequest },
  });
  await campaign.update({ templateId, scheduledAt, status: "scheduled", executionDate: null });
  return {
    campaign: serializeCampaign(await campaign.reload()),
    scheduled: true,
    scheduledAt,
    queueJob,
    totalQueued: 0,
    queued: [],
  };
}

async function dispatchScheduledCampaign(campaignId, body = {}) {
  const { CrmMarketingCampaign } = getModels();
  const campaign = await CrmMarketingCampaign.findByPk(campaignId);
  if (!campaign) throw notFound("Campaign");
  if (campaign.status === "cancelled") return { skipped: true, reason: "campaign_cancelled", campaignId };
  if (campaign.status === "paused") {
    const error = new Error("Scheduled campaign is paused.");
    error.code = "CAMPAIGN_PAUSED";
    throw error;
  }
  if (campaign.status !== "scheduled") {
    return { skipped: true, reason: `campaign_${campaign.status}`, campaignId };
  }
  return queueCampaignMessages(campaignId, { ...body, scheduledAt: null, _scheduledDispatch: true, source: "scheduled_campaign" });
}

async function scheduleRecipientBatches(campaign, body, recipients, controls) {
  const chunks = [];
  for (let index = 0; index < recipients.length; index += controls.batchSize) {
    chunks.push(recipients.slice(index, index + controls.batchSize));
  }
  let runAt = deliveryWindow.nextAllowedDeliveryAt(new Date(), controls.deliveryWindow);
  const firstRunAt = new Date(runAt);
  const jobs = [];
  for (let index = 0; index < chunks.length; index += 1) {
    if (index > 0) runAt = deliveryWindow.nextBatchAt(runAt, controls);
    jobs.push(await queueJobs.scheduleUniqueJob({
      dedupeKey: `marketing-recipient-batch:${campaign.id}:${index}`,
      jobType: queueJobs.JOB_TYPES.MARKETING_RECIPIENT_BATCH,
      locationId: campaign.locationId,
      priority: 45,
      runAt,
      maxAttempts: 8,
      payload: {
        campaignId: campaign.id,
        batchIndex: index,
        totalBatches: chunks.length,
        sendRequest: {
          ...body,
          scheduledAt: null,
          _scheduledDispatch: true,
          _recipientBatchDispatch: true,
          recipients: chunks[index],
        },
      },
    }));
  }
  await campaign.update({ status: "sending", executionDate: campaign.executionDate || firstRunAt });
  return {
    campaign: serializeCampaign(await campaign.reload()),
    batched: true,
    totalBatches: chunks.length,
    batchSize: controls.batchSize,
    batchIntervalMinutes: controls.batchIntervalMinutes,
    firstBatchAt: jobs[0]?.runAt || null,
    lastBatchAt: jobs[jobs.length - 1]?.runAt || null,
    queueJobs: jobs,
    queued: [],
    totalQueued: 0,
  };
}

async function dispatchRecipientBatch(campaignId, body, { batchIndex = 0, totalBatches = 1 } = {}) {
  const result = await queueCampaignMessages(campaignId, { ...body, _recipientBatchDispatch: true, scheduledAt: null });
  if (batchIndex >= totalBatches - 1) {
    const { CrmMarketingCampaign } = getModels();
    const campaign = await CrmMarketingCampaign.findByPk(campaignId);
    if (campaign?.status === "sending") await campaign.update({ status: "sent" });
  }
  return { ...result, batchIndex, totalBatches };
}

async function queueCampaignMessages(campaignId, body = {}) {
  const { CrmMarketingCampaign, CrmMarketingTemplate } = getModels();
  const campaign = await CrmMarketingCampaign.findByPk(campaignId);
  if (!campaign) throw notFound("Campaign");
  assertMarketingQueueConfigured(campaignQueueType(campaign));
  await assertMarketingWorkerOnline({ audience: hasAudienceSelection(body) || campaign.campaignType === "workflow_campaign" });
  validate([
    campaign.status === "paused" && { field: "status", message: "Resume the campaign before queueing more recipients." },
    campaign.status === "cancelled" && { field: "status", message: "Cancelled campaigns cannot be queued." },
  ]);

  const scheduledAt = requestedSchedule(body);
  if (scheduledAt) return scheduleCampaignDispatch(campaign, body, scheduledAt);

  if (body._scheduledDispatch === true && campaign.status === "scheduled") {
    await campaign.update({ status: "sending", executionDate: new Date() });
  }

  if (hasAudienceSelection(body)) {
    return createCampaignAudienceJob(campaign, body);
  }

  const recipientInput = Array.isArray(body.recipients) ? body.recipients : [];
  const recipients = normalizeRecipients(recipientInput);
  const dripSteps = await prepareDripCampaign(campaign, body);
  const templateId = dripSteps?.[0]?.templateId || body.templateId || campaign.templateId;
  validate([
    !templateId && { field: "templateId", message: "Choose a template before queueing a campaign." },
    recipients.length === 0 && { field: "recipients", message: "At least one recipient is required." },
    recipients.length !== recipientInput.length && { field: "recipients", message: "Every recipient must include a valid email address." },
    recipients.length > 500 && { field: "recipients", message: "Queue at most 500 recipients per request." },
  ]);

  const { globalData } = await validateCampaignQueueContext(campaign, { ...body, templateId }, recipients);

  const queueType = campaignQueueType(campaign);
  const controls = deliveryWindow.normalizeDeliveryControls(body);
  if (body._recipientBatchDispatch !== true && (
    controls.batchIntervalMinutes > 0
      || controls.deliveryWindow.enabled
      || recipients.length > controls.batchSize
  )) {
    return scheduleRecipientBatches(campaign, body, recipients, controls);
  }
  const allowResend = body.allowResend === true;
  const queued = [];
  const suppressed = [];
  const duplicates = [];
  const existing = [];
  const seen = new Set();

  for (const recipient of recipients) {
    const key = recipient.email.toLowerCase();
    if (seen.has(key)) {
      duplicates.push({ email: recipient.email });
      continue;
    }
    seen.add(key);

    const suppression = await suppressionService.isSuppressed(campaign.locationId, recipient.email);
    if (suppression) {
      suppressed.push({
        email: recipient.email,
        reason: suppression.reason,
        suppressionId: suppression.id,
      });
      continue;
    }

    if (!allowResend && !dripSteps) {
      const existingMessage = await findExistingCampaignRecipient(campaign.id, recipient.email);
      if (existingMessage) {
        existing.push({
          email: recipient.email,
          messageId: existingMessage.id,
          status: existingMessage.status,
        });
        continue;
      }
    }

    if (queued.length === 0) {
      await campaign.update({
        templateId,
        status: "sending",
        executionDate: campaign.executionDate || new Date(),
      });
    }

    const payload = {
      data: { ...globalData, ...(recipient.data || {}) },
      from: body.from || undefined,
      subject: recipient.subject || body.subject || undefined,
    };
    if (dripSteps) {
      const result = await dripService.enrollRecipient({
        campaign,
        recipient: recipient.email,
        data: payload.data,
        steps: dripSteps,
        sendOptions: { from: body.from || null, subject: body.subject || null },
      });
      if (!result.created) {
        existing.push({ email: recipient.email, enrollmentId: result.enrollment.id, status: result.enrollment.status });
        continue;
      }
      queued.push({ id: result.enrollment.id, recipient: recipient.email, status: "enrolled", drip: true });
      continue;
    }
    const message = await marketingMessageRepository.createMessage({
      locationId: campaign.locationId,
      campaignId: campaign.id,
      templateId,
      channel: "email",
      recipient: recipient.email,
      subject: recipient.subject || body.subject || campaign.name,
      payload,
      metadata: {
        queueType,
        source: body.source || "campaign_queue",
      },
    });
    const enqueue = await enqueueMarketingMessage({
      messageId: message.id,
      campaignId: campaign.id,
      channel: "email",
      queueType,
    });
    const updated = await marketingMessageRepository.markQueued(message, enqueue);
    await marketingMessageRepository.createDeliveryEvent({
      messageId: updated.id,
      campaignId: campaign.id,
      eventType: enqueue?.skipped ? "enqueue_skipped" : "queued",
      payload: { source: "campaign_queue", enqueue, queueType },
    });
    queued.push({
      id: updated.id,
      recipient: updated.recipient,
      status: updated.status,
      enqueue,
    });
  }

  if (queued.length) {
    await campaign.increment("totalRecipients", { by: queued.length });
    await campaign.reload();
  }
  if (body._recipientBatchDispatch !== true && campaign.status === "sending") {
    await campaign.update({ status: "sent" });
  }

  return {
    campaign: serializeCampaign(await campaign.reload()),
    queued,
    totalQueued: queued.length,
    suppressed,
    totalSuppressed: suppressed.length,
    duplicates,
    totalDuplicates: duplicates.length,
    existing,
    totalExisting: existing.length,
    allowResend,
    queueType,
  };
}

async function retryCampaignMessage(messageId, body = {}) {
  const { CrmMarketingMessage, CrmMarketingTemplate, CrmMarketingCampaign } = getModels();
  const message = await CrmMarketingMessage.findByPk(messageId);
  if (!message) throw notFound("Marketing message");
  const campaign = message.campaignId
    ? await CrmMarketingCampaign.findByPk(message.campaignId)
    : null;
  if (message.channel !== "email") {
    validate([{ field: "channel", message: "Only email marketing messages can be retried." }]);
  }
  const retryableStatuses = ["failed", "pending"];
  validate([
    !retryableStatuses.includes(message.status) && {
      field: "status",
      message: `Only ${retryableStatuses.join(" or ")} messages can be retried.`,
    },
  ]);

  const template = message.templateId ? await CrmMarketingTemplate.findByPk(message.templateId) : null;
  if (!template) throw notFound("Template");
  const compliance = analyzeTemplateCompliance(template);
  const retryData = message.payload?.data && typeof message.payload.data === "object" ? message.payload.data : {};
  const templateValidation = validateTemplateBeforeSend(template, {
    subject: message.subject || message.payload?.subject,
    recipients: [{ email: message.recipient, data: retryData }],
    data: retryData,
  });
  validate([
    template.useCase === "transactional" && {
      field: "templateId",
      message: "Transactional templates cannot be retried through marketing queues.",
    },
    !compliance.hasUnsubscribeLink && {
      field: "templateId",
      message: "Marketing templates must include an unsubscribe link before retrying.",
    },
    compliance.usesRuntimeUnsubscribe && !compliance.hasRuntimeUrlBase && {
      field: "templateId",
      message: "Set CRM_TRACKING_BASE_URL before retrying templates that use {{unsubscribeUrl}}.",
    },
    ...templateValidation.errors.map((issue) => ({
      field: issue.key,
      message: issue.message,
    })),
  ]);

  const suppression = await suppressionService.isSuppressed(message.locationId, message.recipient);
  validate([
    suppression && {
      field: "recipient",
      message: `Recipient is suppressed (${suppression.reason}). Release the suppression before retrying.`,
    },
  ]);

  const currentMetadata = message.metadata || {};
  const queueType = campaign
    ? campaignQueueType(campaign)
    : currentMetadata.queueType || "bulk";
  const retryCount = Number(currentMetadata.retryCount || 0) + 1;
  const previousStatus = message.status;
  await message.update({
    status: "pending",
    metadata: {
      ...currentMetadata,
      queueType,
      retryCount,
      lastRetryAt: new Date().toISOString(),
      retryReason: body.reason ? String(body.reason).slice(0, 500) : null,
      lastRetryPreviousStatus: previousStatus,
    },
  });

  const enqueue = await enqueueMarketingMessage({
    messageId: message.id,
    campaignId: message.campaignId,
    channel: "email",
    queueType,
  });
  const updated = await marketingMessageRepository.markQueued(message, enqueue);
  await marketingMessageRepository.createDeliveryEvent({
    messageId: updated.id,
    campaignId: updated.campaignId,
    eventType: enqueue?.skipped ? "retry_enqueue_skipped" : "retry_queued",
    payload: {
      source: "campaign_activity_retry",
      enqueue,
      queueType,
      retryCount,
      previousStatus,
    },
  });

  if (updated.campaignId) {
    if (campaign && campaign.status !== "sending") {
      await campaign.update({
        status: "sending",
        executionDate: campaign.executionDate || new Date(),
      });
    }
  }

  return {
    message: serializeMessage(updated),
    enqueue,
    queueType,
    retryCount,
  };
}

async function retryFailedMessages(body = {}) {
  const loc = requireLocation(body.locationId);
  const { CrmMarketingCampaign, CrmMarketingMessage } = getModels();
  const where = { locationId: loc, status: "failed" };
  const messageIds = Array.isArray(body.messageIds) ? body.messageIds.filter(Boolean) : [];
  if (messageIds.length) where.id = { [Op.in]: messageIds };
  if (body.campaignId) where.campaignId = body.campaignId;

  const candidates = await CrmMarketingMessage.findAll({
    where,
    include: [{ model: CrmMarketingCampaign, as: "campaign", required: false }],
    order: [["updatedAt", "DESC"]],
    limit: Math.min(100, Math.max(1, Number(body.limit) || 100)),
  });
  const filtered = body.failureGroup
    ? candidates.filter((row) => failureGroupKey(messageFailureReason(row)) === body.failureGroup)
    : candidates;

  const retried = [];
  const failed = [];
  for (const row of filtered) {
    try {
      const result = await retryCampaignMessage(row.id, {
        queueType: body.queueType || row.metadata?.queueType || "bulk",
        reason: body.reason || "Bulk retry from failed message inbox",
      });
      retried.push(result.message);
    } catch (err) {
      failed.push({
        id: row.id,
        recipient: row.recipient,
        error: err.message,
      });
    }
  }

  return {
    retried,
    failed,
    totalCandidates: candidates.length,
    totalMatched: filtered.length,
    totalRetried: retried.length,
    totalFailed: failed.length,
  };
}

async function pauseCampaign(id, body = {}) {
  const { CrmMarketingCampaign } = getModels();
  const campaign = await CrmMarketingCampaign.findByPk(id);
  if (!campaign) throw notFound("Campaign");
  validate([
    !["scheduled", "sending"].includes(campaign.status) && {
      field: "status",
      message: "Only scheduled or sending campaigns can be paused.",
    },
  ]);
  await campaign.update({
    status: "paused",
  });
  if (campaign.campaignType === "workflow_campaign") await dripService.pauseCampaignEnrollments(campaign.id);
  return {
    campaign: serializeCampaign(campaign),
    action: "paused",
    reason: body.reason || null,
  };
}

async function resumeCampaign(id, body = {}) {
  const { CrmMarketingCampaign, CrmQueueJob } = getModels();
  const campaign = await CrmMarketingCampaign.findByPk(id);
  if (!campaign) throw notFound("Campaign");
  validate([
    campaign.status !== "paused" && {
      field: "status",
      message: "Only paused campaigns can be resumed.",
    },
  ]);
  const scheduledJob = await CrmQueueJob.findOne({ where: { dedupeKey: `marketing-campaign-dispatch:${campaign.id}` } });
  const nextStatus = scheduledJob ? "scheduled" : "sending";
  await campaign.update({
    status: nextStatus,
    executionDate: nextStatus === "scheduled" ? null : (campaign.executionDate || new Date()),
  });
  const resumableJobs = await CrmQueueJob.findAll({
    where: {
      [Op.or]: [
        { dedupeKey: `marketing-campaign-dispatch:${campaign.id}` },
        { dedupeKey: { [Op.like]: `marketing-recipient-batch:${campaign.id}:%` } },
      ],
      status: { [Op.in]: ["pending", "processing", "completed", "failed"] },
    },
  });
  for (const job of resumableJobs) {
    const originalRunAt = new Date(job.runAt || 0);
    await job.update({
      status: "pending",
      attempts: 0,
      runAt: originalRunAt > new Date() ? originalRunAt : new Date(),
      lockedAt: null,
      lockedBy: null,
      completedAt: null,
      lastError: null,
    });
  }
  const resumedEnrollments = campaign.campaignType === "workflow_campaign"
    ? await dripService.resumeCampaignEnrollments(campaign.id)
    : 0;
  return {
    campaign: serializeCampaign(campaign),
    action: "resumed",
    reason: body.reason || null,
    resumedEnrollments,
  };
}

async function cancelCampaign(id, body = {}) {
  const { CrmMarketingCampaign, CrmMarketingMessage, CrmQueueJob } = getModels();
  const campaign = await CrmMarketingCampaign.findByPk(id);
  if (!campaign) throw notFound("Campaign");
  validate([
    !["scheduled", "sending", "paused"].includes(campaign.status) && {
      field: "status",
      message: "Only scheduled, sending, or paused campaigns can be stopped.",
    },
  ]);
  const reason = body.reason ? String(body.reason).slice(0, 500) : "Campaign cancelled";
  const cancellableMessages = await CrmMarketingMessage.findAll({
    where: {
      campaignId: campaign.id,
      status: { [Op.in]: ["pending", "queued", "sending"] },
    },
    limit: 1000,
  });
  for (const message of cancellableMessages) {
    await message.update({
      status: "cancelled",
      metadata: {
        ...(message.metadata || {}),
        cancelledAt: new Date().toISOString(),
        cancelReason: reason,
      },
    });
    await marketingMessageRepository.createDeliveryEvent({
      messageId: message.id,
      campaignId: campaign.id,
      eventType: "cancelled",
      payload: {
        source: "campaign_control",
        reason,
      },
    });
  }
  await campaign.update({ status: "cancelled" });
  await CrmQueueJob.update(
    { status: "cancelled", completedAt: new Date(), lockedAt: null, lockedBy: null },
    {
      where: {
        [Op.or]: [
          { dedupeKey: `marketing-campaign-dispatch:${campaign.id}` },
          { dedupeKey: { [Op.like]: `marketing-recipient-batch:${campaign.id}:%` } },
        ],
        status: { [Op.in]: ["pending", "processing"] },
      },
    }
  );
  const cancelledEnrollments = campaign.campaignType === "workflow_campaign"
    ? await dripService.cancelCampaignEnrollments(campaign.id, reason)
    : 0;
  return {
    campaign: serializeCampaign(campaign),
    action: "cancelled",
    totalCancelled: cancellableMessages.length + cancelledEnrollments,
    reason,
  };
}

async function listSuppressions(query = {}) {
  return suppressionService.listSuppressions(query);
}

async function createSuppression(body = {}) {
  return suppressionService.suppressEmail({ ...body, source: body.source || "manual" });
}

async function releaseSuppression(locationId, id) {
  return suppressionService.releaseSuppression(locationId, id);
}

async function updateCampaign(id, body = {}) {
  const { CrmMarketingCampaign } = getModels();
  const row = await CrmMarketingCampaign.findByPk(id);
  if (!row) throw notFound("Campaign");
  if (body.status && !VALID_CAMPAIGN_STATUSES.includes(body.status)) {
    validate([{ field: "status", message: `Status must be one of: ${VALID_CAMPAIGN_STATUSES.join(", ")}.` }]);
  }
  await row.update({
    name: body.name ?? row.name,
    folderId: body.folderId === null ? null : body.folderId ?? row.folderId,
    templateId: body.templateId === null ? null : body.templateId ?? row.templateId,
    status: body.status ?? row.status,
    scheduledAt: body.scheduledAt === null ? null : body.scheduledAt ?? row.scheduledAt,
  });
  return serializeCampaign(row);
}

async function deleteCampaign(id) {
  const { CrmMarketingCampaign } = getModels();
  const row = await CrmMarketingCampaign.findByPk(id);
  if (!row) throw notFound("Campaign");
  validate([
    !["draft", "cancelled"].includes(row.status) && {
      field: "status",
      message: "Only draft or cancelled campaigns can be deleted. Keep completed campaigns for reporting.",
    },
  ]);
  const snapshot = serializeCampaign(row);
  await row.destroy();
  return snapshot;
}

// ── Statistics ──────────────────────────────────────────────────────
//
// Campaign-level aggregation. Reads denormalised counters off the
// campaign row so the Statistics tab is O(N campaigns) rather than
// scanning every event.

function parseRange(query = {}) {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 7 * 86400000);
  const from = query.from ? new Date(query.from) : defaultFrom;
  const to = query.to ? new Date(query.to) : now;
  if (query.to && /^\d{4}-\d{2}-\d{2}$/.test(query.to)) {
    to.setUTCHours(23, 59, 59, 999);
  }
  return { from, to };
}

async function getStatistics(query = {}) {
  const loc = requireLocation(query.locationId);
  const { CrmMarketingCampaign } = getModels();
  const { from, to } = parseRange(query);

  const where = {
    locationId: loc,
    // A reporting range is about when a campaign ran, not when its draft was
    // first created. Unsent drafts must not inflate campaign performance.
    [Op.or]: [
      { executionDate: { [Op.between]: [from, to] } },
      { executionDate: null, scheduledAt: { [Op.between]: [from, to] } },
    ],
  };
  if (query.campaignType) where.campaignType = query.campaignType;

  const campaigns = await CrmMarketingCampaign.findAll({ where });

  const totals = campaigns.reduce(
    (acc, c) => {
      // BIGINT values can be returned as strings by the database driver.
      // Coercing here prevents totals such as "01020".
      acc.recipients += Number(c.totalRecipients || 0);
      acc.delivered += Number(c.totalDelivered || 0);
      acc.opened += Number(c.totalOpened || 0);
      acc.clicked += Number(c.totalClicked || 0);
      acc.bounced += Number(c.totalBounced || 0);
      acc.unsubscribed += Number(c.totalUnsubscribed || 0);
      acc.complained += Number(c.totalComplained || 0);
      return acc;
    },
    { recipients: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0, complained: 0 }
  );

  // Engagement summary breakdown by campaign type.
  const byType = { email_campaign: {}, workflow_campaign: {}, bulk_action_campaign: {} };
  for (const c of campaigns) {
    const bucket = byType[c.campaignType] || (byType[c.campaignType] = {});
    bucket.delivered = (bucket.delivered || 0) + Number(c.totalDelivered || 0);
    bucket.opened = (bucket.opened || 0) + Number(c.totalOpened || 0);
    bucket.clicked = (bucket.clicked || 0) + Number(c.totalClicked || 0);
    bucket.unsubscribed = (bucket.unsubscribed || 0) + Number(c.totalUnsubscribed || 0);
  }

  // Engagement-rate buckets per campaign execution day for the chart.
  const dayBuckets = new Map();
  for (const c of campaigns) {
    const reportDate = c.executionDate || c.scheduledAt;
    if (!reportDate) continue;
    const day = new Date(reportDate).toISOString().slice(0, 10);
    const b = dayBuckets.get(day) || { delivered: 0, opened: 0, clicked: 0 };
    b.delivered += Number(c.totalDelivered || 0);
    b.opened += Number(c.totalOpened || 0);
    b.clicked += Number(c.totalClicked || 0);
    dayBuckets.set(day, b);
  }
  const openRateSeries = Array.from(dayBuckets.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, v]) => ({
      day,
      delivered: v.delivered,
      opened: v.opened,
      clicked: v.clicked,
      openRate: v.delivered > 0 ? Math.round((v.opened / v.delivered) * 10000) / 100 : 0,
      clickRate: v.delivered > 0 ? Math.round((v.clicked / v.delivered) * 10000) / 100 : 0,
    }));

  // Rate, not audience size, determines the top performer. Click count is a
  // stable tie-breaker for campaigns with the same rate.
  const top = campaigns
    .map(serializeCampaign)
    .filter((c) => c.metrics.delivered > 0)
    .sort((a, b) => {
      const aRate = Number(a.metrics.clicked || 0) / Number(a.metrics.delivered || 1);
      const bRate = Number(b.metrics.clicked || 0) / Number(b.metrics.delivered || 1);
      return bRate - aRate || Number(b.metrics.clicked || 0) - Number(a.metrics.clicked || 0);
    })
    .slice(0, 5);

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    campaignCount: campaigns.length,
    totals,
    byType,
    openRateSeries,
    topPerformers: top,
  };
}

// Enqueue a single marketing email (no campaign) — used by the automation
// engine's send_email action. Respects suppression and the org business footer.
async function enqueueSingleMessage({ locationId, templateId, recipient, data = {}, subject, source = "automation" }) {
  const { CrmMarketingTemplate } = getModels();
  const email = String(recipient || "").trim();
  if (!email) return { status: "skipped", reason: "no recipient email" };
  if (!templateId) return { status: "skipped", reason: "no template selected" };
  const template = await CrmMarketingTemplate.findByPk(templateId);
  if (!template) return { status: "skipped", reason: "template not found" };
  if (template.useCase === "transactional") return { status: "skipped", reason: "template is transactional" };

  const suppression = await suppressionService.isSuppressed(locationId, email);
  if (suppression) return { status: "suppressed", reason: "recipient suppressed" };

  const resolvedSubject = subject || template.subject || template.name;
  const message = await marketingMessageRepository.createMessage({
    locationId,
    templateId,
    channel: "email",
    recipient: email,
    subject: resolvedSubject,
    payload: { data: mergeBusinessDefaults(data), subject: resolvedSubject },
    metadata: { source },
  });
  const enqueue = await enqueueMarketingMessage({ messageId: message.id, channel: "email", queueType: "bulk" });
  const updated = await marketingMessageRepository.markQueued(message, enqueue);
  await marketingMessageRepository.createDeliveryEvent({
    messageId: updated.id,
    eventType: enqueue?.skipped ? "enqueue_skipped" : "queued",
    payload: { source, enqueue },
  });
  return { status: updated.status, messageId: updated.id, skipped: Boolean(enqueue?.skipped) };
}

async function listCampaignAudienceJobs(query = {}) {
  const { CrmMarketingCampaignAudienceJob } = getModels();
  const where = {};
  if (query.locationId) where.locationId = Number(query.locationId);
  if (query.campaignId) where.campaignId = query.campaignId;
  if (query.status) where.status = String(query.status);
  const limit = Math.min(100, Math.max(1, Number(query.limit || query.pageSize || 25)));
  const rows = await CrmMarketingCampaignAudienceJob.findAll({
    where,
    limit,
    order: [["createdAt", "DESC"]],
  });
  return { items: rows.map(serializeAudienceJob), pageSize: limit };
}

async function getCampaignAudienceJob(id, query = {}) {
  const { CrmMarketingCampaignAudienceJob } = getModels();
  const where = { id };
  if (query.locationId) where.locationId = Number(query.locationId);
  const row = await CrmMarketingCampaignAudienceJob.findOne({ where });
  if (!row) throw notFound("Campaign audience job");
  return serializeAudienceJob(row);
}

function contactMessageData(contact) {
  return {
    contact: {
      id: contact.id,
      email: contact.email,
      firstName: contact.firstName,
      lastName: contact.lastName,
      fullName: contact.fullName,
      phone: contact.phone,
      lifecycle: contact.lifecycle,
      tags: Array.isArray(contact.tags) ? contact.tags : [],
      customFields: contact.customFields || {},
    },
  };
}

async function buildAudienceContactScope(models, locationId, audience = {}) {
  const customFields = await contactService.loadCustomFields(locationId);
  const segmentIds = Array.isArray(audience.segmentIds) && audience.segmentIds.length
    ? audience.segmentIds
    : (audience.segmentId ? [audience.segmentId] : []);
  const scope = contactService.buildSearchScope(models, locationId, {
    segmentId: segmentIds.length === 1 ? segmentIds[0] : null,
    filters: audience.filters,
    search: audience.search,
    customFields,
  });
  if (segmentIds.length > 1) {
    scope.include = [{
      model: models.CrmSegmentMember,
      as: "segmentMemberships",
      where: { segmentId: { [Op.in]: segmentIds }, status: "active" },
      attributes: [],
      required: true,
    }];
  }
  const ids = Array.isArray(audience.ids) ? audience.ids.filter(Boolean) : [];
  if (ids.length) {
    scope.where = { [Op.and]: [scope.where, { id: { [Op.in]: ids } }] };
  }
  return scope;
}

async function processCampaignAudienceBatch(job) {
  const models = getModels();
  const audience = job.audience || {};
  const sendOptions = job.sendOptions || {};
  const dripSteps = sendOptions.queueType === "journey"
    ? cleanDripSteps(sendOptions.dripSteps)
    : [];
  const controls = deliveryWindow.normalizeDeliveryControls(sendOptions);
  const batchSize = controls.batchSize;
  const campaign = await models.CrmMarketingCampaign.findOne({ where: { id: job.campaignId, locationId: job.locationId } });
  if (!campaign) throw notFound("Campaign");
  if (campaign.status === "cancelled") {
    const updated = await job.update({ status: "cancelled", completedAt: new Date(), lastError: "campaign_cancelled" });
    return serializeAudienceJob(updated);
  }
  if (campaign.status === "paused") {
    const updated = await job.update({ status: "queued", lastError: "campaign_paused" });
    return serializeAudienceJob(updated);
  }

  if (campaign.campaignType === "workflow_campaign") await prepareDripCampaign(campaign, { dripSteps });
  await validateCampaignQueueContext(campaign, { ...sendOptions, templateId: job.templateId }, []);
  if (!job.startedAt) await job.update({ status: "processing", startedAt: new Date(), lastError: null });
  else await job.update({ status: "processing", lastError: null });

  const { where, include } = await buildAudienceContactScope(models, job.locationId, audience);
  if (job.totalTargeted === null || job.totalTargeted === undefined) {
    const totalTargeted = await models.CrmContact.count({ where, include, distinct: include.length > 0 });
    await job.update({ totalTargeted });
  }

  const pageWhere = job.lastContactId
    ? { [Op.and]: [where, { id: { [Op.gt]: job.lastContactId } }] }
    : where;
  const contacts = await models.CrmContact.findAll({
    where: pageWhere,
    include,
    order: [["id", "ASC"]],
    limit: batchSize,
  });

  if (!contacts.length) {
    const finalStatus = Number(job.failedCount || 0) > 0 ? "completed_with_errors" : "completed";
    const updated = await job.update({ status: finalStatus, completedAt: new Date() });
    await campaign.reload();
    if (campaign.campaignType === "workflow_campaign") await dripService.finishCampaignIfDone(campaign.id);
    else if (campaign.status === "sending") await campaign.update({ status: "sent" });
    return serializeAudienceJob(updated);
  }

  let processedCount = 0;
  let queuedCount = 0;
  let suppressedCount = 0;
  let duplicateCount = 0;
  let ineligibleCount = 0;
  let failedCount = 0;
  const errors = Array.isArray(job.errors) ? [...job.errors] : [];
  const globalData = mergeBusinessDefaults(sendOptions.data && typeof sendOptions.data === "object" ? sendOptions.data : {});
  const eligible = [];

  for (const contact of contacts) {
    processedCount += 1;
    const email = String(contact.email || "").trim();
    if (!EMAIL_RE.test(email) || contact.marketingStatus !== "subscribed" || contact.doNotContact) {
      ineligibleCount += 1;
      continue;
    }
    eligible.push({ contact, email, normalizedEmail: email.toLowerCase() });
  }

  const normalizedEmails = Array.from(new Set(eligible.map((item) => item.normalizedEmail)));
  const suppressions = normalizedEmails.length
    ? await models.CrmMarketingSuppression.findAll({
        where: {
          locationId: job.locationId,
          email: { [Op.in]: normalizedEmails },
          active: true,
        },
      })
    : [];
  const suppressedEmails = new Set(suppressions.map((row) => String(row.email || "").toLowerCase()));
  const existingMessages = campaign.campaignType !== "workflow_campaign" && !sendOptions.allowResend && normalizedEmails.length
    ? await models.CrmMarketingMessage.findAll({
        where: {
          campaignId: campaign.id,
          recipient: { [Op.in]: normalizedEmails },
        },
        attributes: ["recipient"],
      })
    : [];
  const existingEmails = new Set(existingMessages.map((row) => String(row.recipient || "").toLowerCase()));
  const seenInBatch = new Set();

  for (const item of eligible) {
    if (seenInBatch.has(item.normalizedEmail) || existingEmails.has(item.normalizedEmail)) {
      duplicateCount += 1;
      continue;
    }
    seenInBatch.add(item.normalizedEmail);
    if (suppressedEmails.has(item.normalizedEmail)) {
      suppressedCount += 1;
      continue;
    }

    try {
      const payload = {
        data: { ...globalData, ...contactMessageData(item.contact) },
        from: sendOptions.from || undefined,
        subject: sendOptions.subject || undefined,
      };
      if (campaign.campaignType === "workflow_campaign") {
        const enrolled = await dripService.enrollRecipient({
          campaign,
          recipient: item.normalizedEmail,
          data: payload.data,
          steps: dripSteps,
          sendOptions: { from: sendOptions.from || null, subject: sendOptions.subject || null },
        });
        if (enrolled.created) queuedCount += 1;
        else duplicateCount += 1;
        continue;
      }
      const message = await marketingMessageRepository.createMessage({
        locationId: campaign.locationId,
        campaignId: campaign.id,
        templateId: job.templateId,
        channel: "email",
        recipient: item.normalizedEmail,
        subject: sendOptions.subject || campaign.name,
        payload,
        metadata: {
          queueType: sendOptions.queueType || "bulk",
          source: sendOptions.source || "campaign_audience",
          audienceJobId: job.id,
          contactId: item.contact.id,
        },
      });
      const enqueue = await enqueueMarketingMessage({
        messageId: message.id,
        campaignId: campaign.id,
        channel: "email",
        queueType: sendOptions.queueType || "bulk",
      });
      const updated = await marketingMessageRepository.markQueued(message, enqueue);
      await marketingMessageRepository.createDeliveryEvent({
        messageId: updated.id,
        campaignId: campaign.id,
        eventType: enqueue?.skipped ? "enqueue_skipped" : "queued",
        payload: { source: "campaign_audience", enqueue, queueType: sendOptions.queueType || "bulk", audienceJobId: job.id },
      });
      queuedCount += 1;
    } catch (err) {
      failedCount += 1;
      if (errors.length < 25) {
        errors.push({ contactId: item.contact.id, email: item.normalizedEmail, message: err.message || String(err) });
      }
    }
  }

  const lastContactId = contacts[contacts.length - 1].id;
  const hasMore = contacts.length === batchSize;
  const updated = await job.update({
    status: hasMore ? "queued" : (Number(job.failedCount || 0) + failedCount > 0 ? "completed_with_errors" : "completed"),
    processedCount: Number(job.processedCount || 0) + processedCount,
    queuedCount: Number(job.queuedCount || 0) + queuedCount,
    suppressedCount: Number(job.suppressedCount || 0) + suppressedCount,
    duplicateCount: Number(job.duplicateCount || 0) + duplicateCount,
    ineligibleCount: Number(job.ineligibleCount || 0) + ineligibleCount,
    failedCount: Number(job.failedCount || 0) + failedCount,
    lastContactId,
    errors,
    completedAt: hasMore ? null : new Date(),
  });

  if (queuedCount) await campaign.increment("totalRecipients", { by: queuedCount });
  if (hasMore) {
    await queueJobs.enqueueJob({
      jobType: queueJobs.JOB_TYPES.MARKETING_CAMPAIGN_AUDIENCE,
      locationId: job.locationId,
      priority: 45,
      payload: { campaignAudienceJobId: job.id },
      runAt: deliveryWindow.nextBatchAt(new Date(), controls),
    });
  } else {
    await campaign.reload();
    if (campaign.campaignType === "workflow_campaign") await dripService.finishCampaignIfDone(campaign.id);
    else if (campaign.status === "sending") await campaign.update({ status: "sent" });
  }
  return serializeAudienceJob(updated);
}

async function processCampaignAudienceJob(campaignAudienceJobId) {
  const { CrmMarketingCampaignAudienceJob } = getModels();
  const job = await CrmMarketingCampaignAudienceJob.findByPk(campaignAudienceJobId);
  if (!job) throw notFound("Campaign audience job");
  try {
    return await processCampaignAudienceBatch(job);
  } catch (err) {
    const errors = Array.isArray(job.errors) ? job.errors : [];
    await job.update({
      status: "failed",
      failedCount: Number(job.failedCount || 0) + 1,
      errors: errors.length < 25 ? [...errors, { message: err.message || String(err) }] : errors,
      lastError: err.message || String(err || "Audience job failed"),
      completedAt: new Date(),
    });
    throw err;
  }
}

async function processDripStep(enrollmentId, stepIndex, retryContext) {
  return dripService.processDripStep(enrollmentId, stepIndex, retryContext);
}

async function listCampaignDripEnrollments(campaignId, query) {
  return dripService.listCampaignEnrollments(campaignId, query);
}

module.exports = {
  getTemplateBuilderCatalog,
  getMergeTagCatalog,
  validateTemplateBeforeSend,
  enqueueSingleMessage,
  listCampaignAudienceJobs,
  getCampaignAudienceJob,
  processCampaignAudienceJob,
  dispatchScheduledCampaign,
  dispatchRecipientBatch,
  processDripStep,
  listCampaignDripEnrollments,
  // folders
  listFolders,
  createFolder,
  deleteFolder,
  // assets
  listAssets,
  createAsset,
  uploadAsset,
  updateAsset,
  deleteAsset,
  // snippets
  listSnippets,
  createSnippet,
  updateSnippet,
  deleteSnippet,
  // templates
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  renderTemplate,
  renderDraftTemplate,
  sendTestTemplate,
  sendTestDraftTemplate,
  listTemplateRevisions,
  getTemplateRevision,
  restoreTemplateRevision,
  // campaigns
  listCampaigns,
  listCampaignMessages,
  listMessageEvents,
  listFailedMessages,
  createCampaign,
  preflightCampaignMessages,
  queueCampaignMessages,
  retryCampaignMessage,
  retryFailedMessages,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  updateCampaign,
  deleteCampaign,
  // suppressions
  listSuppressions,
  createSuppression,
  releaseSuppression,
  // statistics
  getStatistics,
};
