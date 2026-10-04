const { DataTypes } = require("sequelize");

module.exports = function defineCrmRssCampaign(sequelize) {
  return sequelize.define("CrmRssCampaign", {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    locationId: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(200), allowNull: false },
    feedUrl: { type: DataTypes.TEXT, allowNull: false },
    templateId: { type: DataTypes.UUID, allowNull: false },
    subjectTemplate: { type: DataTypes.STRING(500), allowNull: false, defaultValue: "{{rss.title}}" },
    audience: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    sendOptions: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    intervalMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 60 },
    status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: "active" },
    sendLatestOnFirstPoll: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    lastItemFingerprint: DataTypes.STRING(64), lastItem: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    nextPollAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }, lastPolledAt: DataTypes.DATE,
    lastPublishedAt: DataTypes.DATE, lastCampaignId: DataTypes.UUID, lastError: DataTypes.TEXT,
    lockedAt: DataTypes.DATE, lockedBy: DataTypes.STRING(160),
  }, { tableName: "crm_rss_campaigns", timestamps: true });
};
