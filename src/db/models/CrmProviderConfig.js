const { DataTypes } = require("sequelize");
const { encryptJson, isEncrypted } = require("../../shared/credentialVault");

function defineCrmProviderConfig(sequelize) {
  return sequelize.define(
    "CrmProviderConfig",
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      locationId: { type: DataTypes.INTEGER, allowNull: true },
      domain: { type: DataTypes.STRING(30), allowNull: false, defaultValue: "marketing" },
      channel: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "email" },
      provider: { type: DataTypes.STRING(50), allowNull: false },
      displayName: { type: DataTypes.STRING(150), allowNull: false },
      priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },
      isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      encryptedConfig: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {},
        set(value) {
          this.setDataValue("encryptedConfig", isEncrypted(value) ? value : encryptJson(value || {}));
        },
      },
      verifiedAt: { type: DataTypes.DATE, allowNull: true },
      lastTestedAt: { type: DataTypes.DATE, allowNull: true },
      lastTestError: { type: DataTypes.TEXT, allowNull: true },
    },
    {
      tableName: "crm_provider_configs",
      timestamps: true,
    }
  );
}

module.exports = defineCrmProviderConfig;
