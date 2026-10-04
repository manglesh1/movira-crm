"use strict";

const { Op } = require("sequelize");

function crmSchema() {
  const schema = process.env.CRM_DB_SCHEMA || "crm";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error("CRM_DB_SCHEMA must be a valid PostgreSQL identifier");
  return schema;
}

const table = (schema) => ({ tableName: "crm_conversation_channel_connections", schema });

module.exports = {
  up: async (queryInterface) => {
    const target = table(crmSchema());
    await queryInterface.removeConstraint(target, "crm_conv_connections_provider_account_uk");
    await queryInterface.addIndex(target, ["channel", "provider", "externalAccountId"], {
      name: "crm_conv_connections_active_provider_account_uk",
      unique: true,
      where: { status: { [Op.ne]: "disconnected" } },
    });
  },

  down: async (queryInterface) => {
    const target = table(crmSchema());
    await queryInterface.removeIndex(target, "crm_conv_connections_active_provider_account_uk");
    await queryInterface.addConstraint(target, {
      fields: ["channel", "provider", "externalAccountId"],
      type: "unique",
      name: "crm_conv_connections_provider_account_uk",
    });
  },
};
