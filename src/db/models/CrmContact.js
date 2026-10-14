const { DataTypes } = require("sequelize");

function defineCrmContact(sequelize) {
  return sequelize.define(
    "CrmContact",
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      locationId: { type: DataTypes.INTEGER, allowNull: false },
      communicationOnly: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      fullName: { type: DataTypes.STRING(240), allowNull: true },
      firstName: { type: DataTypes.STRING(120), allowNull: true },
      lastName: { type: DataTypes.STRING(120), allowNull: true },
      email: { type: DataTypes.STRING(320), allowNull: true },
      normalizedEmail: { type: DataTypes.STRING(320), allowNull: true },
      phone: { type: DataTypes.STRING(60), allowNull: true },
      normalizedPhone: { type: DataTypes.STRING(60), allowNull: true },
      sourceType: {
        type: DataTypes.STRING(40),
        allowNull: false,
        defaultValue: "manual",
      },
      sourceRefType: { type: DataTypes.STRING(80), allowNull: true },
      sourceRefId: { type: DataTypes.STRING(120), allowNull: true },
      // Maintained by the database for API, imports and direct chat-service writes.
      originalSource: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      sourceHistory: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      lifecycle: {
        type: DataTypes.STRING(40),
        allowNull: false,
        defaultValue: "lead",
      },
      marketingStatus: {
        type: DataTypes.STRING(40),
        allowNull: false,
        defaultValue: "subscribed",
      },
      smsStatus: {
        type: DataTypes.STRING(40),
        allowNull: false,
        defaultValue: "unknown",
      },
      doNotContact: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      tags: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
      },
      customFields: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {},
      },
      sourceSnapshot: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {},
      },
      lastEngagedAt: { type: DataTypes.DATE, allowNull: true },
    },
    {
      tableName: "crm_contacts",
      timestamps: true,
    }
  );
}

module.exports = defineCrmContact;
