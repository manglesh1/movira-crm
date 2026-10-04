require("dotenv").config();
const { getModels } = require("../src/db/models");
const { decryptJsonIfNeeded } = require("../src/shared/credentialVault");

async function main() {
  const apply = process.argv.includes("--apply");
  const { sequelize, CrmProviderConfig } = getModels();
  const rows = await CrmProviderConfig.findAll({ order: [["createdAt", "ASC"]] });
  let validated = 0;
  let rotated = 0;
  for (const row of rows) {
    const plaintext = decryptJsonIfNeeded(row.encryptedConfig);
    validated += 1;
    if (apply) {
      // Passing plaintext through the model setter always encrypts it with the
      // current key ID. Keep previous keys configured until this finishes.
      await row.update({ encryptedConfig: plaintext });
      rotated += 1;
    }
  }
  process.stdout.write(`${apply ? "Rotated" : "Validated"} ${apply ? rotated : validated} provider credential record(s).\n`);
  if (!apply) process.stdout.write("Dry run only. Re-run with --apply after confirming CRM_CREDENTIALS_PREVIOUS_KEYS contains every old key.\n");
  await sequelize.close();
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
