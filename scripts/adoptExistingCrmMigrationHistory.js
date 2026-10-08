"use strict";

const { QueryTypes } = require("sequelize");
const { getSequelize } = require("../src/db/sequelize");

const META_TABLE = 'public."SequelizeMetaCrm"';

// These migrations produced the CRM schema included in the platform's
// 2026-10-07 production baseline. Keep this list frozen: future migration
// files must run normally and must never be auto-adopted.
const BASELINE_MIGRATIONS = Object.freeze([
  "20260507000000-create-crm-schema.js",
  "20260507000100-create-transactional-messages.js",
  "20260507000200-create-transactional-templates-and-events.js",
  "20260507000400-create-crm-email-settings.js",
  "20260507000500-create-crm-email-domain-routes.js",
  "20260507030000-add-domain-sender-warmup-fields.js",
  "20260507040000-create-crm-email-reply-forward-settings.js",
  "20260507050000-create-crm-marketing-tables.js",
  "20260507060000-add-use-case-to-marketing-templates.js",
  "20260507060000-create-crm-trigger-links.js",
  "20260507070000-create-crm-marketing-messages-and-events.js",
  "20260510010000-create-crm-marketing-assets.js",
  "20260510020000-create-crm-marketing-snippets.js",
  "20260510030000-create-crm-marketing-template-revisions.js",
  "20260510040000-create-crm-marketing-suppressions.js",
  "20260510050000-create-crm-marketing-worker-heartbeats.js",
  "20260510060000-create-crm-audit-logs.js",
  "20260512000000-create-crm-event-template-bindings.js",
  "20260512000300-add-design-fields-to-transactional-templates.js",
  "20260512000400-add-family-fields-to-transactional-templates.js",
  "20260512000500-add-attachments-to-transactional-messages.js",
  "20260521000100-create-crm-contacts-foundation.js",
  "20260521000200-create-crm-segments-foundation.js",
  "20260521000300-create-crm-automation-foundation.js",
  "20260521000400-create-crm-contact-fields.js",
  "20260521000500-create-crm-contact-notes.js",
  "20260521000600-create-crm-contact-tags.js",
  "20260531000100-create-crm-queue-jobs.js",
  "20260531000200-extend-crm-contact-import-jobs-for-queue.js",
  "20260531000300-add-crm-contact-filter-indexes.js",
  "20260531000400-create-crm-contact-filter-counts.js",
  "20260531000500-create-crm-contact-bulk-action-jobs.js",
  "20260531000600-create-crm-contact-export-jobs.js",
  "20260531000700-add-invalidated-at-to-crm-contact-filter-counts.js",
  "20260531000800-add-storage-fields-to-crm-contact-export-jobs.js",
  "20260601000100-create-crm-marketing-campaign-audience-jobs.js",
  "20260601000200-create-crm-automation-enrollment-jobs.js",
  "20260605090000-create-crm-marketing-calendar.js",
  "20260611000100-add-ses-identity-fields-to-crm-email-domains.js",
  "20260611000200-add-provider-config-to-crm-email-domains.js",
  "20260611000300-create-crm-sender-warmup.js",
  "20260616000100-move-crm-tables-to-crm-schema.js",
  "20260913000100-create-crm-marketing-drip-enrollments.js",
  "20260922090000-add-booking-reminder-binding.js",
  "20260927090000-add-voucher-pack-purchased-binding.js",
  "20260928093000-add-member-password-reset-notification.js",
  "20261002000100-create-crm-conversations-foundation.js",
  "20261002000200-create-crm-conversation-oauth-states.js",
  "20261002000300-allow-disconnected-social-account-reconnect.js",
  "20261002000400-create-crm-provider-capacity.js",
  "20261002000500-index-provider-capacity-accepted.js",
  "20261002000600-add-queue-job-dedupe-key.js",
  "20261002000700-encrypt-email-provider-configs.js",
  "20261002000800-create-crm-rss-campaigns.js",
  "20261004000100-create-crm-conversation-workspace.js",
]);

const REQUIRED_TABLES = Object.freeze([
  "crm_transactional_messages",
  "crm_transactional_templates",
  "crm_provider_configs",
  "crm_email_domains",
  "crm_contacts",
  "crm_segments",
  "crm_automation_workflows",
  "crm_queue_jobs",
  "crm_marketing_campaigns",
  "crm_marketing_drip_enrollments",
  "crm_conversation_channel_connections",
  "crm_conversation_oauth_states",
  "crm_conversation_workspace_configs",
  "crm_provider_capacities",
  "crm_rss_campaigns",
]);

const REQUIRED_COLUMNS = Object.freeze([
  ["crm_queue_jobs", "dedupeKey"],
  ["crm_conversation_channel_connections", "disconnectedAt"],
  ["crm_provider_configs", "encryptedConfig"],
]);

async function adoptExistingCrmMigrationHistory(sequelize, schema = "crm") {
  await sequelize.query(
    `CREATE TABLE IF NOT EXISTS ${META_TABLE} ("name" VARCHAR(255) NOT NULL PRIMARY KEY)`
  );

  return sequelize.transaction(async (transaction) => {
    await sequelize.query(
      "SELECT pg_advisory_xact_lock(hashtext('movira-crm-migration-baseline'))",
      { transaction }
    );

    const appliedCount = await sequelize.query(
      `SELECT COUNT(*)::int AS count FROM ${META_TABLE}`,
      { type: QueryTypes.SELECT, transaction }
    );
    if (Number(appliedCount[0]?.count || 0) > 0) {
      return { adopted: false, reason: "history_exists" };
    }

    const existingTables = await sequelize.query(
      `SELECT table_name AS name
         FROM information_schema.tables
        WHERE table_schema = :schema
          AND table_name IN (:tables)`,
      {
        replacements: { schema, tables: REQUIRED_TABLES },
        type: QueryTypes.SELECT,
        transaction,
      }
    );
    const tableNames = new Set(existingTables.map((row) => row.name));
    if (tableNames.size === 0) {
      throw new Error(
        "CRM schema is not initialized. Run the movira-platform-admin production baseline first, then rerun the CRM migration command."
      );
    }

    const missingTables = REQUIRED_TABLES.filter((table) => !tableNames.has(table));
    const existingColumns = await sequelize.query(
      `SELECT table_name AS "tableName", column_name AS "columnName"
         FROM information_schema.columns
        WHERE table_schema = :schema
          AND (table_name, column_name) IN (
            ('crm_queue_jobs', 'dedupeKey'),
            ('crm_conversation_channel_connections', 'disconnectedAt'),
            ('crm_provider_configs', 'encryptedConfig')
          )`,
      { replacements: { schema }, type: QueryTypes.SELECT, transaction }
    );
    const columnNames = new Set(
      existingColumns.map((row) => `${row.tableName}.${row.columnName}`)
    );
    const missingColumns = REQUIRED_COLUMNS.filter(
      ([table, column]) => !columnNames.has(`${table}.${column}`)
    );

    if (missingTables.length || missingColumns.length) {
      const missing = [
        ...missingTables.map((table) => `${schema}.${table}`),
        ...missingColumns.map(([table, column]) => `${schema}.${table}.${column}`),
      ];
      throw new Error(
        `Refusing to adopt a partial CRM schema. Missing canonical objects: ${missing.join(", ")}`
      );
    }

    for (const name of BASELINE_MIGRATIONS) {
      await sequelize.query(
        `INSERT INTO ${META_TABLE} ("name") VALUES (:name) ON CONFLICT ("name") DO NOTHING`,
        { replacements: { name }, transaction }
      );
    }
    return { adopted: true, count: BASELINE_MIGRATIONS.length };
  });
}

async function main() {
  const sequelize = getSequelize();
  try {
    const result = await adoptExistingCrmMigrationHistory(
      sequelize,
      process.env.CRM_DB_SCHEMA || "crm"
    );
    console.log(`[crm-migrations] ${JSON.stringify(result)}`);
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[crm-migrations] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  BASELINE_MIGRATIONS,
  REQUIRED_TABLES,
  REQUIRED_COLUMNS,
  adoptExistingCrmMigrationHistory,
};
