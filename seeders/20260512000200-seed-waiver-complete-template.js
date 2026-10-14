"use strict";

const template = {
  key: "waiver-complete",
  name: "Waiver completion confirmation",
  category: "waiver",
  subject: "Your waiver is signed - {{locationName}}",
  body: [
    "<h1>Waiver signed</h1>",
    "<p>Hi {{guestName}},</p>",
    "<p>Thanks for completing your waiver for {{locationName}}.</p>",
    "<p>Your waiver is valid until {{expiryDate}} ({{expiryDays}} days).</p>",
  ].join("\n"),
  variables: ["guestName", "locationName", "expiryDate", "expiryDays"],
};

const binding = {
  eventType: "waiver.completed",
  templateKey: "waiver-complete",
  priority: "normal",
};

module.exports = {
  up: async (queryInterface) => {
    const [existingTemplate] = await queryInterface.sequelize.query(
      `
      SELECT id FROM crm_transactional_templates
      WHERE "locationId" IS NULL AND key = :key AND channel = 'email'
      LIMIT 1
      `,
      { replacements: { key: template.key } }
    );

    const templateRow = {
      locationId: null,
      key: template.key,
      channel: "email",
      name: template.name,
      category: template.category,
      subject: template.subject,
      body: template.body,
      config: JSON.stringify({ contentType: "html", textFallback: null }),
      variables: JSON.stringify(template.variables),
      isSystem: true,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (existingTemplate.length) {
      await queryInterface.bulkUpdate(
        "crm_transactional_templates",
        {
          name: templateRow.name,
          category: templateRow.category,
          subject: templateRow.subject,
          body: templateRow.body,
          config: templateRow.config,
          variables: templateRow.variables,
          isSystem: true,
          isActive: true,
          updatedAt: templateRow.updatedAt,
        },
        { locationId: null, key: template.key, channel: "email" }
      );
    } else {
      await queryInterface.bulkInsert("crm_transactional_templates", [templateRow]);
    }

    const [existingBinding] = await queryInterface.sequelize.query(
      `
      SELECT id FROM crm_event_template_bindings
      WHERE "eventType" = :eventType
        AND channel = 'email'
        AND "locationId" IS NULL
      LIMIT 1
      `,
      { replacements: { eventType: binding.eventType } }
    );

    const bindingRow = {
      eventType: binding.eventType,
      channel: "email",
      locationId: null,
      templateKey: binding.templateKey,
      priority: binding.priority,
      variableMap: JSON.stringify({}),
      isActive: true,
      notes: "System default binding",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (existingBinding.length) {
      await queryInterface.bulkUpdate(
        "crm_event_template_bindings",
        {
          templateKey: bindingRow.templateKey,
          priority: bindingRow.priority,
          isActive: true,
          updatedAt: bindingRow.updatedAt,
        },
        { eventType: binding.eventType, channel: "email", locationId: null }
      );
    } else {
      await queryInterface.bulkInsert("crm_event_template_bindings", [bindingRow]);
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `DELETE FROM crm_event_template_bindings WHERE "eventType" = :eventType AND channel = 'email' AND "locationId" IS NULL`,
      { replacements: { eventType: binding.eventType } }
    );
    await queryInterface.sequelize.query(
      `DELETE FROM crm_transactional_templates WHERE "isSystem" = true AND channel = 'email' AND key = :key`,
      { replacements: { key: template.key } }
    );
  },
};
