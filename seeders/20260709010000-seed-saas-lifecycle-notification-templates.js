"use strict";

const {
  buildTransactionalSystemDesign,
  buildTransactionalPlainText,
  collectTransactionalVariables,
} = require("../src/modules/transactional/systemTemplateDesigns");

const templates = [
  {
    slug: "saasInvoiceVoided",
    name: "SaaS invoice voided",
    family: "saas",
    category: "saas-billing",
    description: "Tell the customer owner that an invoice is no longer payable.",
    subject: "Invoice {{invoiceNumber}} has been voided",
    heading: "Invoice voided",
    paragraph:
      "Hi {{guestName}},<br/>Invoice <strong>{{invoiceNumber}}</strong> for <strong>{{locationName}}</strong> has been voided and is no longer payable.",
  },
  {
    slug: "saasInvoiceRefunded",
    name: "SaaS invoice refunded",
    family: "saas",
    category: "saas-billing",
    description: "Confirm a SaaS invoice refund to the customer owner.",
    subject: "Refund processed for invoice {{invoiceNumber}}",
    heading: "Refund processed",
    paragraph:
      "Hi {{guestName}},<br/>A refund has been processed for invoice <strong>{{invoiceNumber}}</strong> for <strong>{{locationName}}</strong>.",
  },
  {
    slug: "saasBillingPastDue",
    name: "SaaS billing past due",
    family: "saas",
    category: "saas-billing",
    description: "Warn the customer owner before billing suspension.",
    subject: "Action needed: invoice {{invoiceNumber}} is past due",
    heading: "Billing is past due",
    paragraph:
      "Hi {{guestName}},<br/>Invoice <strong>{{invoiceNumber}}</strong> for <strong>{{locationName}}</strong> is past due. Please review the balance and due date below.",
  },
  {
    slug: "saasBillingSuspended",
    name: "SaaS billing suspended",
    family: "saas",
    category: "saas-billing",
    description: "Notify the customer owner when a location is paused for non-payment.",
    subject: "{{locationName}} is paused for billing",
    heading: "Billing hold applied",
    paragraph:
      "Hi {{guestName}},<br/><strong>{{locationName}}</strong> has been paused because invoice <strong>{{invoiceNumber}}</strong> is overdue.",
  },
  {
    slug: "saasBillingRecovered",
    name: "SaaS billing recovered",
    family: "saas",
    category: "saas-billing",
    description: "Confirm that the SaaS billing account is back in good standing.",
    subject: "{{locationName}} billing is back in good standing",
    heading: "Billing recovered",
    paragraph:
      "Hi {{guestName}},<br/>Billing for <strong>{{locationName}}</strong> is back in good standing.",
  },
  {
    slug: "saasParkGoLive",
    name: "SaaS location go-live approved",
    family: "saas",
    category: "saas-onboarding",
    description: "Tell the customer owner that their location is live.",
    subject: "{{locationName}} is live on Movira",
    heading: "Your location is live",
    paragraph:
      "Hi {{guestName}},<br/><strong>{{locationName}}</strong> has been approved for live operations.",
  },
  {
    slug: "saasParkGoLiveBlocked",
    name: "SaaS location go-live blocked",
    family: "saas",
    category: "saas-onboarding",
    description: "Tell the customer owner that location go-live needs more checks.",
    subject: "{{locationName}} needs checks before go-live",
    heading: "Go-live needs attention",
    paragraph:
      "Hi {{guestName}},<br/><strong>{{locationName}}</strong> is not live yet because required checks are incomplete. Review the status below.",
  },
];

const bindings = [
  { eventType: "saas.invoice.voided", templateKey: "saasInvoiceVoided", priority: "normal" },
  { eventType: "saas.invoice.refunded", templateKey: "saasInvoiceRefunded", priority: "high" },
  { eventType: "saas.billing.past_due", templateKey: "saasBillingPastDue", priority: "normal" },
  { eventType: "saas.billing.suspended", templateKey: "saasBillingSuspended", priority: "high" },
  { eventType: "saas.billing.recovered", templateKey: "saasBillingRecovered", priority: "normal" },
  { eventType: "saas.park.go_live", templateKey: "saasParkGoLive", priority: "high" },
  { eventType: "saas.park.go_live_blocked", templateKey: "saasParkGoLiveBlocked", priority: "normal" },
];

function buildBody(template) {
  return [`<h1>${template.heading}</h1>`, `<p>${template.paragraph}</p>`].join("\n");
}

function buildVariables(template) {
  const set = new Set();
  const text = `${template.subject || ""} ${template.heading || ""} ${template.paragraph || ""}`;
  const re = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
  let match;
  while ((match = re.exec(text)) !== null) set.add(match[1]);
  return Array.from(set);
}

module.exports = {
  up: async (queryInterface) => {
    for (const template of templates) {
      const body = buildBody(template);
      const defaults = {
        subject: template.subject,
        heading: template.heading,
        paragraph: template.paragraph,
      };
      const designSource = {
        key: template.slug,
        name: template.name,
        family: template.family,
        category: template.category,
        description: template.description,
        subject: template.subject,
        body,
        defaults,
      };
      const designJson = buildTransactionalSystemDesign(designSource);
      const plainText = buildTransactionalPlainText(designSource);
      const variables = collectTransactionalVariables({ ...designSource, plainText }, designJson);
      const [existing] = await queryInterface.sequelize.query(
        `
        SELECT id FROM crm_transactional_templates
        WHERE "locationId" IS NULL AND key = :key AND channel = 'email'
        LIMIT 1
        `,
        { replacements: { key: template.slug } }
      );

      const row = {
        locationId: null,
        key: template.slug,
        channel: "email",
        name: template.name,
        category: template.category,
        family: template.family,
        description: template.description,
        subject: template.subject,
        body,
        editorType: "design",
        designJson: JSON.stringify(designJson),
        plainText,
        config: JSON.stringify({ contentType: "html", textFallback: null }),
        defaults: JSON.stringify(defaults),
        variables: JSON.stringify(variables.length ? variables : buildVariables(template)),
        isSystem: true,
        isActive: true,
        updatedAt: new Date(),
      };

      if (existing.length) {
        await queryInterface.bulkUpdate(
          "crm_transactional_templates",
          row,
          { locationId: null, key: template.slug, channel: "email", isSystem: true }
        );
      } else {
        await queryInterface.bulkInsert("crm_transactional_templates", [{ ...row, createdAt: new Date() }]);
      }
    }

    for (const binding of bindings) {
      const [existing] = await queryInterface.sequelize.query(
        `
        SELECT id FROM crm_event_template_bindings
        WHERE "eventType" = :eventType
          AND channel = 'email'
          AND "locationId" IS NULL
        LIMIT 1
        `,
        { replacements: { eventType: binding.eventType } }
      );

      const row = {
        eventType: binding.eventType,
        channel: "email",
        locationId: null,
        templateKey: binding.templateKey,
        priority: binding.priority,
        variableMap: JSON.stringify({}),
        isActive: true,
        notes: "System default SaaS lifecycle binding",
        updatedAt: new Date(),
      };

      if (existing.length) {
        await queryInterface.bulkUpdate(
          "crm_event_template_bindings",
          row,
          { eventType: binding.eventType, channel: "email", locationId: null }
        );
      } else {
        await queryInterface.bulkInsert("crm_event_template_bindings", [{ ...row, createdAt: new Date() }]);
      }
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `
      DELETE FROM crm_event_template_bindings
      WHERE channel = 'email'
        AND "locationId" IS NULL
        AND "eventType" IN (:eventTypes)
      `,
      { replacements: { eventTypes: bindings.map((binding) => binding.eventType) } }
    );
    await queryInterface.sequelize.query(
      `
      DELETE FROM crm_transactional_templates
      WHERE "isSystem" = true
        AND "locationId" IS NULL
        AND channel = 'email'
        AND key IN (:keys)
      `,
      { replacements: { keys: templates.map((template) => template.slug) } }
    );
  },
};
