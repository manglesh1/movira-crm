"use strict";

function schemaName() {
  const value = process.env.CRM_DB_SCHEMA || "crm";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error("CRM_DB_SCHEMA must be a valid PostgreSQL identifier");
  return value;
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const schema = schemaName();
    const table = { tableName: "crm_rss_campaigns", schema };
    await queryInterface.createTable(table, {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.literal("gen_random_uuid()"), primaryKey: true },
      locationId: { type: Sequelize.INTEGER, allowNull: false },
      name: { type: Sequelize.STRING(200), allowNull: false }, feedUrl: { type: Sequelize.TEXT, allowNull: false },
      templateId: { type: Sequelize.UUID, allowNull: false, references: { model: { tableName: "crm_marketing_templates", schema }, key: "id" }, onDelete: "RESTRICT" },
      subjectTemplate: { type: Sequelize.STRING(500), allowNull: false, defaultValue: "{{rss.title}}" },
      audience: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} }, sendOptions: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      intervalMinutes: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 60 }, status: { type: Sequelize.STRING(30), allowNull: false, defaultValue: "active" },
      sendLatestOnFirstPoll: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      lastItemFingerprint: Sequelize.STRING(64), lastItem: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      nextPollAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") }, lastPolledAt: Sequelize.DATE,
      lastPublishedAt: Sequelize.DATE, lastCampaignId: { type: Sequelize.UUID, allowNull: true, references: { model: { tableName: "crm_marketing_campaigns", schema }, key: "id" }, onDelete: "SET NULL" },
      lastError: Sequelize.TEXT, lockedAt: Sequelize.DATE, lockedBy: Sequelize.STRING(160),
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") }, updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
    });
    await queryInterface.addIndex(table, ["locationId", "status", "nextPollAt"], { name: "crm_rss_campaigns_due_idx" });
  },
  async down(queryInterface) {
    await queryInterface.dropTable({ tableName: "crm_rss_campaigns", schema: schemaName() });
  },
};
