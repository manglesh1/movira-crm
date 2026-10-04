const { DataTypes } = require("sequelize");

function defineCrmProviderCapacity(sequelize) {
  return sequelize.define(
    "CrmProviderCapacity",
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      scopeKey: { type: DataTypes.STRING(160), allowNull: false, unique: true },
      provider: { type: DataTypes.STRING(50), allowNull: false },
      region: { type: DataTypes.STRING(50), allowNull: false },
      max24HourSend: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      maxSendRate: { type: DataTypes.DECIMAL(12, 3), allowNull: false, defaultValue: 0 },
      observedSentLast24Hours: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      unobservedAccepted: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      reservedTransactional: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      reservedMarketing: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      rateWindowStartedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      rateWindowUsed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      quotaFetchedAt: { type: DataTypes.DATE, allowNull: true },
      metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    },
    { tableName: "crm_provider_capacities", timestamps: true }
  );
}

module.exports = defineCrmProviderCapacity;
