const { DataTypes } = require("sequelize");

function defineCrmProviderCapacityReservation(sequelize) {
  return sequelize.define(
    "CrmProviderCapacityReservation",
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      capacityId: { type: DataTypes.UUID, allowNull: false },
      messageType: { type: DataTypes.STRING(30), allowNull: false },
      messageId: { type: DataTypes.UUID, allowNull: false },
      locationId: { type: DataTypes.INTEGER, allowNull: false },
      useCase: { type: DataTypes.STRING(30), allowNull: false },
      status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: "pending" },
      expiresAt: { type: DataTypes.DATE, allowNull: false },
      acceptedAt: { type: DataTypes.DATE, allowNull: true },
      releasedAt: { type: DataTypes.DATE, allowNull: true },
      metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    },
    { tableName: "crm_provider_capacity_reservations", timestamps: true }
  );
}

module.exports = defineCrmProviderCapacityReservation;
