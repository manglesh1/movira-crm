const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
test("AWS deployment replaces and starts the conversations worker that consumes webchat and human replies", () => {
  const workflow = readFileSync(resolve(__dirname, "../.github/workflows/deploy-crm.yml"), "utf8");
  assert.match(workflow, /node --check src\/workers\/conversationsWorker\.js/);
  assert.match(workflow, /movira-crm-conversations-worker\s+do/);
  assert.match(workflow, /pm2 start src\/workers\/conversationsWorker\.js --name movira-crm-conversations-worker --time/);
});
