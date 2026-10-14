"use strict";

// Move the existing records, rather than copying them into a second writable
// store. Simple compatibility views preserve legacy SQL and existing IDs.
const tables = {
  guest_ai_contacts: "crm_chat_contacts",
  guest_ai_leads: "crm_leads",
  guest_ai_lead_sessions: "crm_lead_sessions",
  guest_ai_lead_deliveries: "crm_lead_deliveries",
  guest_ai_lead_configs: "crm_lead_configs",
};

module.exports = {
  async up(qi, Sequelize) {
    const schema = process.env.CRM_DB_SCHEMA || "crm";
    const legacy = process.env.CRM_LEGACY_SCHEMA || "public";
    const quote = value => qi.queryGenerator.quoteIdentifier(value);
    const s = quote(schema), p = quote(legacy);
    await qi.sequelize.transaction(async transaction => {
      const sql = statement => qi.sequelize.query(statement, { transaction });
      for (const [oldName, newName] of Object.entries(tables)) {
        await sql(`ALTER TABLE ${p}.${quote(oldName)} SET SCHEMA ${s}`);
        await sql(`ALTER TABLE ${s}.${quote(oldName)} RENAME TO ${quote(newName)}`);
        // Deliberately select the original columns before adding new fields.
        await sql(`CREATE VIEW ${p}.${quote(oldName)} AS SELECT * FROM ${s}.${quote(newName)}`);
      }
      await qi.addColumn({ schema, tableName: "crm_contacts" }, "communicationOnly", {
        type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false,
      }, { transaction });
      await sql(`ALTER TABLE ${s}.crm_chat_contacts
        ADD COLUMN crm_contact_id uuid,
        ADD COLUMN identity_key varchar(320),
        ADD COLUMN channel varchar(40) NOT NULL DEFAULT 'webchat',
        ALTER COLUMN normalized_email DROP NOT NULL`);
      await sql(`DROP INDEX IF EXISTS ${s}.guest_ai_contacts_location_email_uq`);
      await sql(`UPDATE ${s}.crm_chat_contacts SET identity_key = 'legacy-email:' || normalized_email,
        crm_contact_id = gen_random_uuid()`);
      await sql(`INSERT INTO ${s}.crm_contacts
        (id, "locationId", "fullName", email, phone, "sourceType", "sourceRefType", "sourceRefId",
         lifecycle, "marketingStatus", "smsStatus", "doNotContact", tags, "customFields", "sourceSnapshot",
         "lastEngagedAt", "communicationOnly", "createdAt", "updatedAt")
        SELECT crm_contact_id, "locationId", display_name, normalized_email, latest_phone,
          'conversation', 'chat_contact', guest_ai_contact_id::text, 'lead', 'unknown', 'unknown', false,
          '[]'::jsonb, '{}'::jsonb, '{"identityVerified":false}'::jsonb,
          last_seen_at, true, created_at, updated_at FROM ${s}.crm_chat_contacts`);
      await sql(`ALTER TABLE ${s}.crm_chat_contacts ADD CONSTRAINT crm_chat_contacts_profile_fk
        FOREIGN KEY (crm_contact_id) REFERENCES ${s}.crm_contacts(id) ON DELETE SET NULL`);
      await sql(`CREATE UNIQUE INDEX crm_chat_contacts_identity_uq ON ${s}.crm_chat_contacts ("locationId", identity_key)`);
      await sql(`CREATE INDEX crm_chat_contacts_email_idx ON ${s}.crm_chat_contacts ("locationId", normalized_email)`);
      await sql(`CREATE INDEX crm_chat_contacts_profile_idx ON ${s}.crm_chat_contacts (crm_contact_id)`);
      await sql(`ALTER TABLE ${s}.crm_leads
        ADD COLUMN crm_contact_id uuid REFERENCES ${s}.crm_contacts(id) ON DELETE SET NULL,
        ADD COLUMN crm_conversation_id uuid REFERENCES ${s}.crm_conversations(id) ON DELETE SET NULL,
        ADD COLUMN channel varchar(40) NOT NULL DEFAULT 'webchat'`);
      await sql(`UPDATE ${s}.crm_leads l SET crm_contact_id = c.crm_contact_id
        FROM ${p}.chat_conversations t JOIN ${s}.crm_chat_contacts c ON c.guest_ai_contact_id = t.guest_ai_contact_id
        WHERE l.chat_conversation_id = t.chat_conversation_id AND l."locationId" = c."locationId"`);
      await sql(`UPDATE ${s}.crm_leads l SET crm_conversation_id = t.id, channel = t.channel
        FROM ${s}.crm_conversations t WHERE l.guest_conversation_id = t.id AND l."locationId" = t."locationId"`);
      await sql(`CREATE INDEX crm_leads_contact_idx ON ${s}.crm_leads ("locationId", crm_contact_id)`);
      await sql(`CREATE INDEX crm_leads_conversation_idx ON ${s}.crm_leads ("locationId", crm_conversation_id)`);
      await qi.addColumn({ schema, tableName: "crm_conversation_messages" }, "authorType", {
        type: Sequelize.STRING(24), allowNull: false, defaultValue: "visitor",
      }, { transaction });
      await sql(`UPDATE ${s}.crm_conversation_messages SET "authorType" = CASE
        WHEN "metadataSafe"->>'author' IN ('ai','system') THEN "metadataSafe"->>'author'
        WHEN direction = 'inbound' THEN 'visitor' ELSE 'staff' END`);
      // Reconcile existing channel histories through the same idempotent worker
      // used for new messages. This does not send messages or lead notifications.
      await sql(`INSERT INTO ${s}.crm_conversation_outbox
        (id, "locationId", "aggregateType", "aggregateId", "eventType", "payloadSafe", status,
         "attemptCount", "availableAt", "createdAt", "updatedAt")
        SELECT gen_random_uuid(), "locationId", 'conversation', id, 'conversation.contact.sync',
          jsonb_build_object('conversationId',id), 'pending', 0, now(), now(), now()
        FROM ${s}.crm_conversations`);
    });
  },
  async down() {
    // Once new channel records exist, narrowing back to an email-only schema
    // would lose identities. Roll back application code using the legacy views.
    throw new Error("Shared conversation records are data-preserving and forward-only. Legacy views support application rollback.");
  },
};
