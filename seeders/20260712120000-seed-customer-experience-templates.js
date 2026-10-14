"use strict";

// Customer Experience email templates + event→template bindings.
//
// The CRM already registers the customer_experience.* events (eventRegistry.js)
// but shipped NO template and NO binding for them, so every CX notification
// handed off from aeroSportsAdmin was rejected 422 binding_not_found (or, if a
// binding was added out-of-band, rendered with a missing/wrong template). This
// seeder adds the guest-facing templates and their system-default bindings so
// the "rate your visit" (feedback request) and recovery-reply emails actually
// deliver. Data-only (templates + bindings) — no CRM code changes.
//
// Modeled on 20260701010000-seed-saas-invoice-notification-templates.js.
// Idempotent: upserts by (locationId=NULL, key, channel) and (eventType, channel, locationId=NULL).

const {
  buildTransactionalSystemDesign,
  buildTransactionalPlainText,
  collectTransactionalVariables,
} = require("../src/modules/transactional/systemTemplateDesigns");

const templates = [
  {
    slug: "customerExperienceFeedbackRequest",
    name: "Customer experience — feedback request",
    family: "customer_experience",
    category: "customer-experience",
    description: "Ask a guest to rate their recent visit via a survey link.",
    subject: "How was your visit to {{locationName}}?",
    heading: "How was your visit?",
    paragraph:
      "Hi {{guestName}},<br/>Thanks for visiting <strong>{{locationName}}</strong>. We'd love to hear how your recent visit went.<br/><br/>The survey takes about a minute and helps our team improve every visit.{{rewardTeaser}}",
  },
  {
    slug: "customerExperienceFeedbackReceived",
    name: "Customer experience - feedback received",
    family: "customer_experience",
    category: "customer-experience",
    description: "Notify configured location staff when a guest submits a matching survey response.",
    subject: "New {{ratingOverall}}/5 guest feedback - {{locationName}}",
    heading: "New guest feedback",
    paragraph:
      "<strong>{{guestName}}</strong> submitted a {{ratingOverall}}/5 response for {{locationName}}. Review the response and follow up when needed.",
  },
  {
    slug: "customerExperienceRecoveryReply",
    name: "Customer experience — recovery reply",
    family: "customer_experience",
    category: "customer-experience",
    description: "Staff reply to a guest following low or at-risk feedback.",
    subject: "A message from {{locationName}}",
    heading: "We'd like to make this right",
    paragraph:
      "Hi {{guestName}},<br/>{{replyMessage}}<br/><br/>Thank you,<br/><strong>{{locationName}}</strong>",
  },
  {
    slug: "customerExperienceRewardIssued",
    name: "Customer experience — reward issued",
    family: "customer_experience",
    category: "customer-experience",
    description: "Send a guest their thank-you reward code after staff verify a public review claim.",
    subject: "Your reward from {{locationName}}",
    heading: "Thanks for sharing the love",
    paragraph:
      "Hi {{guestName}},<br/>Thanks for taking a moment to review <strong>{{locationName}}</strong> — it means a lot to our team.<br/><br/>Here is your {{rewardOffer}}reward code:<br/><strong style=\"font-size:20px;letter-spacing:2px;\">{{rewardCode}}</strong><br/>{{rewardExpiryLine}}<br/><br/>{{rewardMessage}}<br/><br/>See you soon,<br/><strong>{{locationName}}</strong>",
  },
];

const bindings = [
  { eventType: "customer_experience.feedback.requested", templateKey: "customerExperienceFeedbackRequest", priority: "normal" },
  { eventType: "customer_experience.feedback.received", templateKey: "customerExperienceFeedbackReceived", priority: "normal" },
  { eventType: "customer_experience.recovery.reply_requested", templateKey: "customerExperienceRecoveryReply", priority: "high" },
  { eventType: "customer_experience.reward.issued", templateKey: "customerExperienceRewardIssued", priority: "normal" },
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
        notes: "System default Customer Experience binding",
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
