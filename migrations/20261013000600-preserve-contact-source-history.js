"use strict";

module.exports = {
  async up(qi, Sequelize) {
    const schema = process.env.CRM_DB_SCHEMA || "crm";
    const table = { schema, tableName: "crm_contacts" };
    const quoted = qi.queryGenerator.quoteTable(table);
    const fn = `${qi.queryGenerator.quoteIdentifier(schema)}.capture_contact_source_history`;
    await qi.sequelize.transaction(async transaction => {
      await qi.addColumn(table, "originalSource", { type: Sequelize.JSONB, allowNull: false, defaultValue: {} }, { transaction });
      await qi.addColumn(table, "sourceHistory", { type: Sequelize.JSONB, allowNull: false, defaultValue: [] }, { transaction });
      // Previously overwritten origins cannot be reconstructed. Preserve only
      // what is known now, explicitly labelled as a legacy snapshot.
      await qi.sequelize.query(`UPDATE ${quoted} SET "originalSource" = jsonb_build_object(
        'sourceType', "sourceType", 'sourceRefType', "sourceRefType", 'sourceRefId', "sourceRefId",
        'recordedAt', clock_timestamp(), 'provenance', 'legacy_snapshot');
        UPDATE ${quoted} SET "sourceHistory" = jsonb_build_array("originalSource");`, { transaction });
      await qi.sequelize.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $body$
        DECLARE entry jsonb;
        BEGIN
          entry := jsonb_build_object('sourceType', NEW."sourceType", 'sourceRefType', NEW."sourceRefType",
            'sourceRefId', NEW."sourceRefId", 'recordedAt', clock_timestamp(), 'provenance', 'captured');
          IF TG_OP = 'INSERT' THEN
            NEW."originalSource" := entry;
            NEW."sourceHistory" := jsonb_build_array(entry);
          ELSE
            NEW."originalSource" := OLD."originalSource";
            NEW."sourceHistory" := OLD."sourceHistory";
            IF ROW(NEW."sourceType", NEW."sourceRefType", NEW."sourceRefId")
              IS DISTINCT FROM ROW(OLD."sourceType", OLD."sourceRefType", OLD."sourceRefId") THEN
              NEW."sourceHistory" := OLD."sourceHistory" || jsonb_build_array(entry);
            END IF;
          END IF;
          RETURN NEW;
        END;
        $body$;
        CREATE TRIGGER crm_contacts_source_history BEFORE INSERT OR UPDATE ON ${quoted}
        FOR EACH ROW EXECUTE FUNCTION ${fn}();`, { transaction });
    });
  },
  async down(qi) {
    const schema = process.env.CRM_DB_SCHEMA || "crm";
    const table = { schema, tableName: "crm_contacts" };
    await qi.sequelize.transaction(async transaction => {
      await qi.sequelize.query(`DROP TRIGGER crm_contacts_source_history ON ${qi.queryGenerator.quoteTable(table)};
        DROP FUNCTION ${qi.queryGenerator.quoteIdentifier(schema)}.capture_contact_source_history();`, { transaction });
      await qi.removeColumn(table, "sourceHistory", { transaction });
      await qi.removeColumn(table, "originalSource", { transaction });
    });
  },
};
