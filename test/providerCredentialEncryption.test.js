const test = require("node:test");
const assert = require("node:assert/strict");
const vault = require("../src/shared/credentialVault");
const defineProvider = require("../src/db/models/CrmProviderConfig");
const { Sequelize } = require("sequelize");

test("credential vault emits versioned authenticated ciphertext", () => {
  const encrypted = vault.encryptJson({ apiKey: "secret", region: "ca-central-1" });
  assert.match(encrypted, /^v2\.[a-zA-Z0-9_-]+\./);
  assert.deepEqual(vault.decryptJson(encrypted), { apiKey: "secret", region: "ca-central-1" });
  assert.equal(encrypted.includes("secret"), false);
});

test("email provider model encrypts config before persistence", () => {
  const sequelize = new Sequelize("postgres://unused:unused@127.0.0.1:5432/unused", { logging: false });
  const Provider = defineProvider(sequelize);
  const row = Provider.build({ provider: "customer_sendgrid", displayName: "SendGrid", encryptedConfig: { apiKey: "sg-secret" } });
  const stored = row.getDataValue("encryptedConfig");
  assert.equal(vault.isEncrypted(stored), true);
  assert.deepEqual(vault.decryptJson(stored), { apiKey: "sg-secret" });
});
