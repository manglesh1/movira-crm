const { DataTypes } = require("sequelize");

function defineCrmQueueJob(sequelize) {
  return sequelize.define(
    "CrmQueueJob",
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      locationId: { type: DataTypes.INTEGER, allowNull: true },
      queueName: {
        type: DataTypes.STRING(60),
        allowNull: false,
        defaultValue: "general",
      },
      jobType: { type: DataTypes.STRING(80), allowNull: false },
      dedupeKey: { type: DataTypes.STRING(240), allowNull: true, unique: true },
      status: {
        type: DataTypes.STRING(40),
        allowNull: false,
        defaultValue: "pending",
      },
      priority: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 50,
      },
      payload: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {},
      },
      result: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {},
      },
      attempts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      maxAttempts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 3,
      },
      runAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      lockedAt: { type: DataTypes.DATE, allowNull: true },
      lockedBy: { type: DataTypes.STRING(160), allowNull: true },
      startedAt: { type: DataTypes.DATE, allowNull: true },
      completedAt: { type: DataTypes.DATE, allowNull: true },
      lastError: { type: DataTypes.TEXT, allowNull: true },
    },
    {
      tableName: "crm_queue_jobs",
      timestamps: true,
      indexes: [
        { fields: ["queueName", "status", "runAt", "priority"] },
        { fields: ["locationId", "queueName", "jobType", "createdAt"] },
        { fields: ["lockedBy", "lockedAt"] },
      ],
    }
  );
}

module.exports = defineCrmQueueJob;
