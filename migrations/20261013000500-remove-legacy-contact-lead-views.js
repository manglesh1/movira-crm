"use strict";

const aliases = [
  ["guest_ai_contacts", "crm_chat_contacts", ["crm_contact_id", "identity_key", "channel", "phone_updated_at"]],
  ["guest_ai_leads", "crm_leads", ["crm_contact_id", "crm_conversation_id", "channel"]],
];

module.exports = {
  async up(qi) {
    const schema = process.env.CRM_DB_SCHEMA || "crm";
    const legacy = process.env.CRM_LEGACY_SCHEMA || "public";
    const quote = (name, namespace) => qi.queryGenerator.quoteTable({ schema: namespace, tableName: name });
    await qi.sequelize.transaction(async transaction => {
      for (const [oldName, canonical] of aliases) {
        const [rows] = await qi.sequelize.query(`SELECT relkind FROM pg_class WHERE oid=to_regclass(:name)`,
          { replacements: { name: quote(oldName, legacy) }, transaction });
        if (!rows.length) continue;
        if (rows[0].relkind !== "v") throw new Error(`${legacy}.${oldName} is not a compatibility view; refusing to remove stored data.`);
        const [target] = await qi.sequelize.query(`SELECT relkind FROM pg_class WHERE oid=to_regclass(:name)`,
          { replacements: { name: quote(canonical, schema) }, transaction });
        if (target[0]?.relkind !== "r") throw new Error(`Canonical table ${schema}.${canonical} is missing.`);
        // No CASCADE: an unexpected dependent object must block removal.
        await qi.sequelize.query(`DROP VIEW ${quote(oldName, legacy)} RESTRICT`, { transaction });
      }
    });
  },
  async down(qi) {
    const schema = process.env.CRM_DB_SCHEMA || "crm";
    const legacy = process.env.CRM_LEGACY_SCHEMA || "public";
    const quote = (name, namespace) => qi.queryGenerator.quoteTable({ schema: namespace, tableName: name });
    await qi.sequelize.transaction(async transaction => {
      for (const [oldName, canonical, addedColumns] of aliases) {
        const [columns] = await qi.sequelize.query(`SELECT attname FROM pg_attribute
          WHERE attrelid=to_regclass(:name) AND attnum>0 AND NOT attisdropped ORDER BY attnum`,
          { replacements: { name: quote(canonical, schema) }, transaction });
        const selection = columns.filter(row => !addedColumns.includes(row.attname))
          .map(row => qi.queryGenerator.quoteIdentifier(row.attname)).join(", ");
        await qi.sequelize.query(`CREATE VIEW ${quote(oldName, legacy)} AS SELECT ${selection} FROM ${quote(canonical, schema)}`, { transaction });
      }
    });
  },
};
