"use strict";

// Lead reconciliation runs on incoming chat activity. Both the canonical
// conversation UUID and the legacy projection ID are active lookup paths.
module.exports = {
  async up(qi) {
    const table = { schema: process.env.CRM_DB_SCHEMA || "crm", tableName: "crm_leads" };
    await qi.sequelize.transaction(async transaction => {
      await qi.addIndex(table, ["locationId", "guest_conversation_id", { name: "created_at", order: "DESC" }],
        { name: "crm_leads_guest_conversation_recent_idx", transaction });
      await qi.addIndex(table, ["locationId", "chat_conversation_id", { name: "created_at", order: "DESC" }],
        { name: "crm_leads_legacy_conversation_recent_idx", transaction });
    });
  },
  async down(qi) {
    const table = { schema: process.env.CRM_DB_SCHEMA || "crm", tableName: "crm_leads" };
    await qi.sequelize.transaction(async transaction => {
      await qi.removeIndex(table, "crm_leads_guest_conversation_recent_idx", { transaction });
      await qi.removeIndex(table, "crm_leads_legacy_conversation_recent_idx", { transaction });
    });
  },
};
