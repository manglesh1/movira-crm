"use strict";

// Rebuilds existing global SaaS templates with the current system design.
// Calling both idempotent seeders also keeps their event bindings intact.
module.exports = {
  async up(queryInterface, Sequelize) {
    await require("./20260701010000-seed-saas-invoice-notification-templates").up(
      queryInterface,
      Sequelize
    );
    await require("./20260709010000-seed-saas-lifecycle-notification-templates").up(
      queryInterface,
      Sequelize
    );
  },
  async down() {
    // Template content is retained so rollback never removes operational email templates.
  },
};
