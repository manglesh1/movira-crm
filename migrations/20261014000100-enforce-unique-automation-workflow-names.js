"use strict";

function schemaName() {
  const value = process.env.CRM_DB_SCHEMA || "crm";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error("CRM_DB_SCHEMA must be a valid PostgreSQL identifier");
  }
  return value;
}

module.exports = {
  async up(queryInterface) {
    const schema = schemaName();
    const table = `"${schema}"."crm_automation_workflows"`;

    // Keep every existing workflow, but make pre-existing duplicate names
    // unambiguous before adding the database-level race-condition guard.
    await queryInterface.sequelize.query(`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY "locationId", LOWER(BTRIM(name))
                 ORDER BY "createdAt", id
               ) AS duplicate_number
        FROM ${table}
      )
      UPDATE ${table} AS workflow
      SET name = LEFT(BTRIM(workflow.name), 160) || ' (' || LEFT(workflow.id::text, 8) || ')'
      FROM ranked
      WHERE ranked.id = workflow.id
        AND ranked.duplicate_number > 1
    `);

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS crm_automation_workflows_location_name_unique
      ON ${table} ("locationId", LOWER(BTRIM(name)))
    `);
  },

  async down(queryInterface) {
    const schema = schemaName();
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "${schema}"."crm_automation_workflows_location_name_unique"
    `);
  },
};
