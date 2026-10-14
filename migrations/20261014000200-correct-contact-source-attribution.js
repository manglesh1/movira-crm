"use strict";

module.exports = {
  async up(qi) {
    const schema = process.env.CRM_DB_SCHEMA || "crm";
    const table = name => qi.queryGenerator.quoteTable({ schema, tableName: name });
    await qi.sequelize.transaction(async transaction => {
      // Correct only demonstrable current attribution. The existing trigger
      // preserves originalSource and appends each correction to sourceHistory.
      await qi.sequelize.query(`UPDATE ${table("crm_contacts")} c
        SET "sourceType"=r.channel, "updatedAt"=now()
        FROM ${table("crm_chat_contacts")} r
        WHERE c."sourceType"='conversation' AND c."communicationOnly"=true
          AND c."sourceRefType"='chat_contact'
          AND c."sourceRefId"=r.guest_ai_contact_id::text
          AND c.id=r.crm_contact_id AND c."locationId"=r."locationId"
          AND r.channel IN ('webchat','guest_ai','facebook','instagram','whatsapp','sms','email','telegram','x','linkedin');
        UPDATE ${table("crm_contacts")} SET "sourceType"='booking', "updatedAt"=now()
        WHERE "sourceType" IN ('movira','webhook') AND "communicationOnly"=false
          AND ("sourceRefType"='booking'
            OR "sourceSnapshot"->>'source'='booking'
            OR ("sourceRefType" IN ('payment','refund_request') AND COALESCE("sourceSnapshot"->>'bookingNumber','') <> '')
            OR CASE WHEN "customFields"->>'bookingCount' ~ '^[0-9]+$'
              THEN ("customFields"->>'bookingCount')::numeric > 0 ELSE false END);`, { transaction });
      if (await qi.tableExists({ schema, tableName: "crm_contact_filter_counts" }, { transaction })) {
        await qi.sequelize.query(`UPDATE ${table("crm_contact_filter_counts")} SET status='stale', "invalidatedAt"=now()`, { transaction });
      }
    });
  },
  async down() {
    // Data corrections and captured history are intentionally retained.
  },
};
