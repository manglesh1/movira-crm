const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  BASELINE_MIGRATIONS,
} = require("../scripts/adoptExistingCrmMigrationHistory");

const root = path.resolve(__dirname, "..");

test("CRM migration metadata is isolated from the platform service", () => {
  const config = fs.readFileSync(path.join(root, "config/config.js"), "utf8");
  assert.match(config, /migrationStorageTableName:\s*"SequelizeMetaCrm"/);
  assert.match(config, /seederStorageTableName:\s*"SequelizeDataCrm"/);
  assert.doesNotMatch(config, /migrationStorageTableName:\s*"SequelizeMetaPlatform"/);
});

test("CRM baseline adoption is frozen to the migrations that built it", () => {
  const files = fs.readdirSync(path.join(root, "migrations"))
    .filter((name) => name.endsWith(".js"))
    .sort();
  assert.deepEqual(BASELINE_MIGRATIONS, files);
});

test("deploy workflow runs the guarded CRM migration command", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/deploy-crm.yml"),
    "utf8"
  );
  assert.match(workflow, /npm run migrate/);
  assert.doesNotMatch(workflow, /^\s+npx sequelize-cli db:migrate$/m);
});

test("CRM bootstrap fails closed until the shared platform baseline exists", () => {
  const adopter = fs.readFileSync(
    path.join(root, "scripts/adoptExistingCrmMigrationHistory.js"),
    "utf8"
  );
  assert.match(adopter, /Run the movira-platform-admin production baseline first/);
  assert.doesNotMatch(adopter, /reason:\s*["']empty_database["']/);
});
