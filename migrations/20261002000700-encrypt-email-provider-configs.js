"use strict";

const { QueryTypes } = require("sequelize");

module.exports = {
  async up(queryInterface) {
    if (!process.env.CRM_CREDENTIALS_ENCRYPTION_KEY) {
      throw new Error("CRM_CREDENTIALS_ENCRYPTION_KEY is required before encrypting existing email provider credentials.");
    }
    const { encryptJson, isEncrypted } = require("../src/shared/credentialVault");
    const schema = process.env.CRM_DB_SCHEMA || "crm";
    const rows = await queryInterface.sequelize.query(
      `SELECT "id", "encryptedConfig" FROM "${schema}"."crm_provider_configs"`,
      { type: QueryTypes.SELECT }
    );
    for (const row of rows) {
      if (isEncrypted(row.encryptedConfig)) continue;
      await queryInterface.sequelize.query(
        `UPDATE "${schema}"."crm_provider_configs" SET "encryptedConfig" = CAST(:encrypted AS jsonb), "updatedAt" = NOW() WHERE "id" = :id`,
        { replacements: { id: row.id, encrypted: JSON.stringify(encryptJson(row.encryptedConfig || {})) } }
      );
    }
  },

  async down() {
    // Encryption is intentionally not reversed: migration rollback must never
    // write usable provider secrets back to plaintext storage.
  },
};
