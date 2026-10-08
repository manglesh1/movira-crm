// Automation execution engine. Runs a workflow's nodes in order against a
// single contact. Wait steps return a durable continuation for the automation
// queue instead of keeping a process asleep. `if_else` chooses one branch.
// dryRun evaluates without side effects (used by the test action).

const { getModels } = require("../../db/models");
const marketingEmail = require("../marketing/email/service");

const UPDATABLE_BUILTIN = new Set(["lifecycle", "marketingStatus", "smsStatus", "doNotContact", "firstName", "lastName", "fullName"]);
const SKIP_REASONS = {
  send_sms: "SMS is not enabled in the email-only phase",
  notify_team: "Notify team is not implemented yet",
  create_task: "Tasks are not implemented yet",
};

function contactMergeData(contact) {
  return {
    email: contact.email,
    firstName: contact.firstName,
    lastName: contact.lastName,
    fullName: contact.fullName,
    phone: contact.phone,
    lifecycle: contact.lifecycle,
    tags: Array.isArray(contact.tags) ? contact.tags : [],
  };
}

function applyMerge(text, contact) {
  return String(text || "").replace(/\{\{\s*contact\.(\w+)\s*\}\}/g, (_, key) => {
    const value = contact[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

function readField(contact, field) {
  if (!field) return undefined;
  if (field.startsWith("cf:")) return contact.customFields ? contact.customFields[field.slice(3)] : undefined;
  return contact[field];
}

function evaluateCondition(contact, config = {}) {
  const operator = config.operator || "equals";
  const actual = String(readField(contact, config.field) ?? "").toLowerCase();
  const expected = String(config.value ?? "").toLowerCase();
  switch (operator) {
    case "equals": return actual === expected;
    case "not_equals": return actual !== expected;
    case "contains": return actual.includes(expected);
    case "is_empty": return actual === "";
    case "is_not_empty": return actual !== "";
    default: return actual === expected;
  }
}

function step(node, status, detail) {
  return { id: node.id, label: node.label, type: node.type, actionId: node.actionId || node.type, status, detail };
}

async function executeNode(node, ctx) {
  const { contact, locationId, dryRun } = ctx;
  const actionId = node.actionId || node.type;
  const config = node.config || {};

  if (node.type === "trigger") return step(node, "success", "Trigger");

  switch (actionId) {
    case "add_tag": {
      const tag = String(config.tag || "").trim();
      if (!tag) return step(node, "skipped", "No tag configured");
      const tags = Array.from(new Set([...(Array.isArray(contact.tags) ? contact.tags : []), tag]));
      contact.set("tags", tags); // applied in-memory so later steps see it (dry-run accurate)
      if (!dryRun) await contact.save();
      return step(node, "success", `Added tag “${tag}”`);
    }
    case "remove_tag": {
      const tag = String(config.tag || "").trim();
      if (!tag) return step(node, "skipped", "No tag configured");
      const tags = (Array.isArray(contact.tags) ? contact.tags : []).filter((t) => t !== tag);
      contact.set("tags", tags);
      if (!dryRun) await contact.save();
      return step(node, "success", `Removed tag “${tag}”`);
    }
    case "update_contact": {
      const field = config.field;
      const value = config.value;
      if (!field) return step(node, "skipped", "No field configured");
      if (field.startsWith("cf:")) {
        contact.set("customFields", { ...(contact.customFields || {}), [field.slice(3)]: value });
        if (!dryRun) await contact.save();
        return step(node, "success", `Set ${field} → ${value}`);
      }
      if (!UPDATABLE_BUILTIN.has(field)) return step(node, "skipped", `Field “${field}” is not updatable by automation`);
      contact.set(field, field === "doNotContact" ? value === true || value === "true" : value);
      if (!dryRun) await contact.save();
      return step(node, "success", `Set ${field} → ${value}`);
    }
    case "internal_note": {
      const body = applyMerge(config.note || "Automation note", contact);
      if (!dryRun) await ctx.models.CrmContactNote.create({ contactId: contact.id, locationId, body, authorName: "Automation" });
      return step(node, "success", "Note added to customer");
    }
    case "send_email": {
      if (dryRun) {
        return step(node, config.template ? "success" : "skipped", config.template ? `Would send template ${config.template}` : "No template selected");
      }
      const result = await marketingEmail.enqueueSingleMessage({
        locationId,
        templateId: config.template,
        recipient: contact.email,
        data: { contact: contactMergeData(contact) },
        source: "automation",
      });
      if (result.status === "skipped" || result.status === "suppressed") return step(node, "skipped", result.reason);
      return step(node, "success", `Email ${result.status}`);
    }
    case "if_else": {
      const passed = evaluateCondition(contact, config);
      return step(node, passed ? "success" : "stopped", passed ? "Condition met" : "Condition not met — run stopped");
    }
    case "wait": {
      const amount = Number(config.amount || config.duration || 0);
      const unit = config.unit || "minutes";
      const waitMs = durationMs(amount, unit);
      if (dryRun) return step(node, "success", `Would wait ${amount || 1} ${unit}`);
      return { ...step(node, "waiting", `Waiting ${amount || 1} ${unit}`), waitMs };
    }
    case "send_sms":
    case "notify_team":
    case "create_task":
      return step(node, "skipped", SKIP_REASONS[actionId] || "Not supported");
    default:
      return step(node, "skipped", `Unsupported action: ${actionId}`);
  }
}

function hasBranchPaths(node) {
  return node.actionId === "if_else" && node.paths
    && ((Array.isArray(node.paths.yes) && node.paths.yes.length) || (Array.isArray(node.paths.no) && node.paths.no.length));
}

// Run a flat list of nodes; an if_else with paths splits into its yes/no branch
// (branch is terminal). Returns { steps, status, lastNodeId }.
async function runSequence(nodeList, ctx, steps) {
  let status = "success";
  let lastNodeId = null;
  for (let index = 0; index < nodeList.length; index += 1) {
    const node = nodeList[index];
    if (node.type === "trigger") continue; // triggers define enrollment, not execution
    lastNodeId = node.id;
    if (hasBranchPaths(node)) {
      const passed = evaluateCondition(ctx.contact, node.config || {});
      steps.push(step(node, "success", passed ? "Condition met → Yes branch" : "Condition not met → No branch"));
      const branch = passed ? (node.paths.yes || []) : (node.paths.no || []);
      const result = await runSequence(branch, ctx, steps);
      return { status: result.status, lastNodeId: result.lastNodeId || lastNodeId };
    }
    let result;
    try {
      result = await executeNode(node, ctx);
    } catch (err) {
      result = step(node, "failed", err.message || "Step failed");
    }
    steps.push(result);
    if (result.status === "failed") return { status: "failed", lastNodeId };
    if (result.status === "stopped") return { status: "stopped", lastNodeId };
    if (result.status === "waiting") {
      return {
        status: "waiting",
        lastNodeId,
        remainingNodes: nodeList.slice(index + 1),
        resumeAt: new Date(Date.now() + result.waitMs).toISOString(),
      };
    }
  }
  return { status, lastNodeId };
}

// Execute a workflow for one contact. Returns { steps, status, currentNodeId }.
async function runForContact(workflow, contact, { dryRun = false, nodesOverride = null, models = null } = {}) {
  let resolvedModels = models;
  const nodes = Array.isArray(nodesOverride) ? nodesOverride : (Array.isArray(workflow.nodes) ? workflow.nodes : []);
  const ctx = {
    get models() {
      if (!resolvedModels) resolvedModels = getModels();
      return resolvedModels;
    },
    contact,
    locationId: workflow.locationId,
    dryRun,
  };
  const steps = [];
  const result = await runSequence(nodes, ctx, steps);
  return {
    steps,
    status: result.status,
    currentNodeId: result.lastNodeId,
    remainingNodes: result.remainingNodes || [],
    resumeAt: result.resumeAt || null,
  };
}

function durationMs(amount, unit) {
  const safeAmount = Math.min(365, Math.max(1, Number(amount) || 1));
  const multiplier = unit === "days" ? 86400000 : unit === "hours" ? 3600000 : 60000;
  return safeAmount * multiplier;
}

module.exports = { runForContact, durationMs };
