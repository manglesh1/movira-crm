"use strict";

function tableName(name) {
  return { tableName: name, schema: process.env.CRM_DB_SCHEMA || "crm" };
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex(tableName("crm_provider_capacity_reservations"), ["capacityId", "status", "acceptedAt"], {
      name: "crm_provider_capacity_reservations_accepted_idx",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      tableName("crm_provider_capacity_reservations"),
      "crm_provider_capacity_reservations_accepted_idx"
    );
  },
};
