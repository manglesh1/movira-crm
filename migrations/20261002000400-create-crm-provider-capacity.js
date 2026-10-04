"use strict";

function crmSchema() {
  return process.env.CRM_DB_SCHEMA || "crm";
}

function tableName(name) {
  return { tableName: name, schema: crmSchema() };
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(tableName("crm_provider_capacities"), {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.literal("gen_random_uuid()"), primaryKey: true, allowNull: false },
      scopeKey: { type: Sequelize.STRING(160), allowNull: false },
      provider: { type: Sequelize.STRING(50), allowNull: false },
      region: { type: Sequelize.STRING(50), allowNull: false },
      max24HourSend: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      maxSendRate: { type: Sequelize.DECIMAL(12, 3), allowNull: false, defaultValue: 0 },
      observedSentLast24Hours: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      unobservedAccepted: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      reservedTransactional: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      reservedMarketing: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      rateWindowStartedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
      rateWindowUsed: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      quotaFetchedAt: { type: Sequelize.DATE, allowNull: true },
      metadata: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
    });
    await queryInterface.addIndex(tableName("crm_provider_capacities"), ["scopeKey"], {
      unique: true,
      name: "crm_provider_capacities_scope_unique",
    });

    await queryInterface.createTable(tableName("crm_provider_capacity_reservations"), {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.literal("gen_random_uuid()"), primaryKey: true, allowNull: false },
      capacityId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: tableName("crm_provider_capacities"), key: "id" },
        onDelete: "CASCADE",
      },
      messageType: { type: Sequelize.STRING(30), allowNull: false },
      messageId: { type: Sequelize.UUID, allowNull: false },
      locationId: { type: Sequelize.INTEGER, allowNull: false },
      useCase: { type: Sequelize.STRING(30), allowNull: false },
      status: { type: Sequelize.STRING(30), allowNull: false, defaultValue: "pending" },
      expiresAt: { type: Sequelize.DATE, allowNull: false },
      acceptedAt: { type: Sequelize.DATE, allowNull: true },
      releasedAt: { type: Sequelize.DATE, allowNull: true },
      metadata: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
    });
    await queryInterface.addIndex(tableName("crm_provider_capacity_reservations"), ["capacityId", "messageType", "messageId"], {
      unique: true,
      name: "crm_provider_capacity_reservations_message_unique",
    });
    await queryInterface.addIndex(tableName("crm_provider_capacity_reservations"), ["capacityId", "status", "expiresAt"], {
      name: "crm_provider_capacity_reservations_active_idx",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(tableName("crm_provider_capacity_reservations"));
    await queryInterface.dropTable(tableName("crm_provider_capacities"));
  },
};
