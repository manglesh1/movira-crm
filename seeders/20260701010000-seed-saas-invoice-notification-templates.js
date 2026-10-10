"use strict";

const {
  buildTransactionalSystemDesign,
  buildTransactionalPlainText,
  collectTransactionalVariables,
} = require("../src/modules/transactional/systemTemplateDesigns");

const templates = [
  {
    slug: "saasOnboardingStarted",
    name: "SaaS onboarding started",
    family: "saas",
    category: "saas-onboarding",
    description: "Welcome a new location owner and explain the onboarding path.",
    subject: "Welcome to Movira — {{locationName}} onboarding has started",
    heading: "Your Movira workspace is ready",
    paragraph:
      "Hi {{guestName}},<br/>Onboarding has started for <strong>{{locationName}}</strong>. The complete setup and owner access details are below.",
  },
  {
    slug: "saasInvoiceIssued",
    name: "SaaS invoice issued",
    family: "saas",
    category: "saas-billing",
    description: "Send SaaS invoice summary after billing is configured or refreshed.",
    subject: "Invoice {{invoiceNumber}} for {{locationName}}",
    heading: "Your Movira invoice is ready",
    paragraph:
      "Hi {{guestName}},<br/>Invoice <strong>{{invoiceNumber}}</strong> for <strong>{{locationName}}</strong> is ready. Review the itemised total below.",
  },
  {
    slug: "saasInvoicePaymentLink",
    name: "SaaS invoice payment link",
    family: "saas",
    category: "saas-billing",
    description: "Send a secure payment link for a SaaS invoice.",
    subject: "Payment link for invoice {{invoiceNumber}}",
    heading: "Complete your Movira payment",
    paragraph:
      "Hi {{guestName}},<br/>Use the secure button below to pay invoice <strong>{{invoiceNumber}}</strong> for <strong>{{locationName}}</strong>.",
  },
  {
    slug: "saasInvoicePaid",
    name: "SaaS invoice paid receipt",
    family: "saas",
    category: "saas-billing",
    description: "Confirm SaaS invoice payment and send receipt information.",
    subject: "Payment received for invoice {{invoiceNumber}}",
    heading: "Payment received",
    paragraph:
      "Hi {{guestName}},<br/>Payment has been received for invoice <strong>{{invoiceNumber}}</strong> for <strong>{{locationName}}</strong>.",
  },
  {
    slug: "saasInvoiceReminder",
    name: "SaaS invoice reminder",
    family: "saas",
    category: "saas-billing",
    description: "Remind a customer owner about a due or overdue SaaS invoice.",
    subject: "Reminder: invoice {{invoiceNumber}} is due for {{locationName}}",
    heading: "Invoice reminder",
    paragraph:
      "Hi {{guestName}},<br/>Invoice <strong>{{invoiceNumber}}</strong> for <strong>{{locationName}}</strong> still has an outstanding balance. If you already paid, no further action is needed.",
  },
];

const bindings = [
  { eventType: "saas.onboarding.started", templateKey: "saasOnboardingStarted", priority: "normal" },
  { eventType: "saas.invoice.issued", templateKey: "saasInvoiceIssued", priority: "normal" },
  { eventType: "saas.invoice.payment_link", templateKey: "saasInvoicePaymentLink", priority: "high" },
  { eventType: "saas.invoice.paid", templateKey: "saasInvoicePaid", priority: "high" },
  { eventType: "saas.invoice.reminder", templateKey: "saasInvoiceReminder", priority: "normal" },
];

function buildBody(template) {
  return [`<h1>${template.heading}</h1>`, `<p>${template.paragraph}</p>`].join("\n");
}

function buildVariables(template) {
  const set = new Set();
  const text = `${template.subject || ""} ${template.heading || ""} ${template.paragraph || ""}`;
  const re = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    set.add(match[1]);
  }
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
        await queryInterface.bulkInsert("crm_transactional_templates", [
          { ...row, createdAt: new Date() },
        ]);
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
        notes: "System default SaaS billing binding",
        updatedAt: new Date(),
      };

      if (existing.length) {
        await queryInterface.bulkUpdate(
          "crm_event_template_bindings",
          row,
          { eventType: binding.eventType, channel: "email", locationId: null }
        );
      } else {
        await queryInterface.bulkInsert("crm_event_template_bindings", [
          { ...row, createdAt: new Date() },
        ]);
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
