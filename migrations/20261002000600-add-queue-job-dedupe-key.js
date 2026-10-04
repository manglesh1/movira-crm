"use strict";

function tableName(name) {
  return { tableName: name, schema: process.env.CRM_DB_SCHEMA || "crm" };
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(tableName("crm_queue_jobs"), "dedupeKey", {
      type: Sequelize.STRING(240),
      allowNull: true,
    });
    await queryInterface.addIndex(tableName("crm_queue_jobs"), ["dedupeKey"], {
      unique: true,
      name: "crm_queue_jobs_dedupe_key_unique",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(tableName("crm_queue_jobs"), "crm_queue_jobs_dedupe_key_unique");
    await queryInterface.removeColumn(tableName("crm_queue_jobs"), "dedupeKey");
  },
};
