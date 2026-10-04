"use strict";

function crmSchema() {
  const schema = process.env.CRM_DB_SCHEMA || "crm";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error("CRM_DB_SCHEMA must be a valid PostgreSQL identifier");
  return schema;
}

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const schema = crmSchema();
    const target = { tableName: "crm_conversation_oauth_states", schema };
    await queryInterface.createTable(target, {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.literal("gen_random_uuid()"), primaryKey: true, allowNull: false },
      locationId: { type: Sequelize.INTEGER, allowNull: false },
      userId: { type: Sequelize.INTEGER, allowNull: false },
      provider: { type: Sequelize.STRING(60), allowNull: false },
      stateHash: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      status: { type: Sequelize.STRING(30), allowNull: false, defaultValue: "pending" },
      encryptedResult: { type: Sequelize.TEXT, allowNull: true },
      resultSafe: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      expiresAt: { type: Sequelize.DATE, allowNull: false },
      consumedAt: { type: Sequelize.DATE, allowNull: true },
      lastErrorCode: { type: Sequelize.STRING(100), allowNull: true },
      lastErrorMessageSafe: { type: Sequelize.TEXT, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
    });
    await queryInterface.addIndex(target, ["locationId", "userId", "status"], { name: "crm_conv_oauth_location_user_status_idx" });
    await queryInterface.addIndex(target, ["expiresAt"], { name: "crm_conv_oauth_expiry_idx" });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable({ tableName: "crm_conversation_oauth_states", schema: crmSchema() });
  },
};
