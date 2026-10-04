"use strict";

function crmSchema() {
  const schema = process.env.CRM_DB_SCHEMA || "crm";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error("CRM_DB_SCHEMA must be a valid PostgreSQL identifier");
  return schema;
}

const table = (schema, tableName) => ({ tableName, schema });
const timestamps = (Sequelize) => ({
  createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
  updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
});
const id = (Sequelize) => ({ type: Sequelize.UUID, defaultValue: Sequelize.literal("gen_random_uuid()"), primaryKey: true, allowNull: false });

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const schema = crmSchema();
    await queryInterface.createTable(table(schema, "crm_conversation_workspace_configs"), {
      id: id(Sequelize), locationId: { type: Sequelize.INTEGER, allowNull: false, unique: true },
      routing: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      preferences: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      updatedByUserId: { type: Sequelize.INTEGER, allowNull: true }, ...timestamps(Sequelize),
    });
    await queryInterface.createTable(table(schema, "crm_conversation_routing_rules"), {
      id: id(Sequelize), locationId: { type: Sequelize.INTEGER, allowNull: false },
      condition: { type: Sequelize.STRING(500), allowNull: false }, destination: { type: Sequelize.STRING(120), allowNull: false },
      priority: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "normal" }, active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      sortOrder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 }, createdByUserId: { type: Sequelize.INTEGER, allowNull: true }, ...timestamps(Sequelize),
    });
    await queryInterface.addIndex(table(schema, "crm_conversation_routing_rules"), ["locationId", "sortOrder"], { name: "crm_conv_routing_location_order_idx" });
    await queryInterface.createTable(table(schema, "crm_conversation_saved_replies"), {
      id: id(Sequelize), locationId: { type: Sequelize.INTEGER, allowNull: false }, title: { type: Sequelize.STRING(180), allowNull: false },
      shortcut: { type: Sequelize.STRING(80), allowNull: false }, category: { type: Sequelize.STRING(80), allowNull: false, defaultValue: "General" },
      body: { type: Sequelize.TEXT, allowNull: false }, usageCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      createdByUserId: { type: Sequelize.INTEGER, allowNull: true }, ...timestamps(Sequelize),
    });
    await queryInterface.addConstraint(table(schema, "crm_conversation_saved_replies"), { fields: ["locationId", "shortcut"], type: "unique", name: "crm_conv_saved_reply_location_shortcut_uk" });
    await queryInterface.createTable(table(schema, "crm_conversation_automation_rules"), {
      id: id(Sequelize), locationId: { type: Sequelize.INTEGER, allowNull: false }, name: { type: Sequelize.STRING(180), allowNull: false },
      trigger: { type: Sequelize.STRING(255), allowNull: false }, action: { type: Sequelize.STRING(255), allowNull: false },
      active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false }, runCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      lastRunAt: { type: Sequelize.DATE, allowNull: true }, createdByUserId: { type: Sequelize.INTEGER, allowNull: true }, ...timestamps(Sequelize),
    });
    await queryInterface.addIndex(table(schema, "crm_conversation_automation_rules"), ["locationId", "active"], { name: "crm_conv_automation_location_active_idx" });
  },
  down: async (queryInterface) => {
    const schema = crmSchema();
    await queryInterface.dropTable(table(schema, "crm_conversation_automation_rules"));
    await queryInterface.dropTable(table(schema, "crm_conversation_saved_replies"));
    await queryInterface.dropTable(table(schema, "crm_conversation_routing_rules"));
    await queryInterface.dropTable(table(schema, "crm_conversation_workspace_configs"));
  },
};
