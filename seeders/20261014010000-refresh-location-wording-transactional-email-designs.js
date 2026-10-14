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

function useLocationTokens(value) {
  if (typeof value === "string") {
    return value.replaceAll("{{venueName}}", "{{locationName}}");
  }
  if (Array.isArray(value)) return value.map(useLocationTokens);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, useLocationTokens(item)])
    );
  }
  return value;
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
        subject: useLocationTokens(template.subject),
        body: useLocationTokens(template.body),
        defaults: useLocationTokens(parseJson(template.defaults, {})),
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
          subject: designSource.subject,
          body: designSource.body,
          defaults: JSON.stringify(designSource.defaults),
          designJson: JSON.stringify(designJson),
          plainText,
          variables: JSON.stringify(variables),
          config: JSON.stringify({
            contentType: "html",
            textFallback: plainText,
            designSystem: "movira360-email-v4-location-language",
          }),
          updatedAt: new Date(),
        },
        { id: template.id }
      );
    }
  },

  // Forward-only terminology refresh for canonical read-only system templates.
  down: async () => {},
};

