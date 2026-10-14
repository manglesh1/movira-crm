"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const schema = process.env.CRM_DB_SCHEMA || "crm";
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn({ schema, tableName: "crm_conversation_channel_connections" }, "widgetSettings", {
        type: Sequelize.JSONB, allowNull: true,
      }, { transaction });
      await queryInterface.addColumn({ schema, tableName: "crm_conversations" }, "handlingMode", {
        type: Sequelize.STRING(24), allowNull: false, defaultValue: "human",
      }, { transaction });
      await queryInterface.addColumn({ schema, tableName: "crm_conversations" }, "handlingVersion", {
        type: Sequelize.INTEGER, allowNull: false, defaultValue: 0,
      }, { transaction });
    });
  },
  async down(queryInterface) {
    const schema = process.env.CRM_DB_SCHEMA || "crm";
    await queryInterface.removeColumn({ schema, tableName: "crm_conversations" }, "handlingVersion");
    await queryInterface.removeColumn({ schema, tableName: "crm_conversations" }, "handlingMode");
    await queryInterface.removeColumn({ schema, tableName: "crm_conversation_channel_connections" }, "widgetSettings");
  },
};
