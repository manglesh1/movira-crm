"use strict";

module.exports = {
  async up(qi, Sequelize) {
    const schema = process.env.CRM_DB_SCHEMA || "crm";
    const table = { schema, tableName: "crm_chat_contacts" };
    const quoted = qi.queryGenerator.quoteTable(table);
    await qi.sequelize.transaction(async transaction => {
      await qi.addColumn(table, "phone_updated_at", { type: Sequelize.DATE, allowNull: true }, { transaction });
      // Historical activity timestamps cannot prove when a phone was supplied.
      // Use first capture as a conservative baseline; lead reconciliation can
      // recover the exact later submission time from the preserved lead.
      await qi.sequelize.query(`UPDATE ${quoted} SET phone_updated_at = first_seen_at
        WHERE NULLIF(BTRIM(latest_phone), '') IS NOT NULL`, { transaction });
    });
  },
  async down(qi) {
    await qi.removeColumn({ schema: process.env.CRM_DB_SCHEMA || "crm", tableName: "crm_chat_contacts" }, "phone_updated_at");
  },
};
