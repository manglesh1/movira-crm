"use strict";

const {
  buildTransactionalSystemDesign,
  buildTransactionalPlainText,
  collectTransactionalVariables,
} = require("../src/modules/transactional/systemTemplateDesigns");

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

module.exports = {
  up: async (queryInterface) => {
    const [templates] = await queryInterface.sequelize.query(
      `
      SELECT id, key, name, family, category, description, subject, body, defaults
      FROM crm_transactional_templates
      WHERE "locationId" IS NULL
        AND channel = 'email'
        AND "isSystem" = true
      ORDER BY key
      `
    );

    for (const template of templates) {
      const designSource = {
        ...template,
        defaults: parseJson(template.defaults, {}),
      };
      const designJson = buildTransactionalSystemDesign(designSource);
      const plainText = buildTransactionalPlainText(designSource);
      const variables = collectTransactionalVariables(
        { ...designSource, plainText },
        designJson
      );

      await queryInterface.bulkUpdate(
        "crm_transactional_templates",
        {
          editorType: "design",
          designJson: JSON.stringify(designJson),
          plainText,
          variables: JSON.stringify(variables),
          config: JSON.stringify({
            contentType: "html",
            textFallback: plainText,
            designSystem: "movira360-email-v3-purple",
          }),
          updatedAt: new Date(),
        },
        { id: template.id }
      );
    }
  },

  // This only refreshes global read-only system templates. Location-specific
  // clones and their custom styling are deliberately left untouched.
  down: async () => {},
};
