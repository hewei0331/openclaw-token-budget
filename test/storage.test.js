const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Set up temp directory before requiring storage
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-test-"));
process.env.HOME = tmpDir;

const storage = require("../storage");

// --- Test readConfig returns defaults when no file exists ---
const config = storage.readConfig();
assert.equal(config.exchangeRate, 7.2, "default exchangeRate");

// --- Test addUsage creates proper structure ---
storage.addUsage("testAgent", 100, 50);
const usage = storage.getUsage("testAgent");
assert.equal(usage.input, 100, "input");
assert.equal(usage.output, 50, "output");

// --- Test getTotalTokens ---
assert.equal(storage.getTotalTokens("testAgent"), 150, "total");

// --- Test addUsage accumulates ---
storage.addUsage("testAgent", 200, 100);
const usage2 = storage.getUsage("testAgent");
assert.equal(usage2.input, 300, "accumulated input");
assert.equal(usage2.output, 150, "accumulated output");

// --- Test getLimit ---
const testConfig = { limits: { main: 50000, default: 5000 } };
assert.equal(storage.getLimit(testConfig, "main"), 50000, "named limit");
assert.equal(storage.getLimit(testConfig, "unknown"), 5000, "default limit");
assert.equal(storage.getLimit(testConfig, null), 5000, "null agent");

// --- Test getModel ---
const modelConfig = { models: { main: "claude-sonnet-4-20250514", default: "gpt-4o-mini" } };
assert.equal(storage.getModel(modelConfig, "main"), "claude-sonnet-4-20250514", "named model");
assert.equal(storage.getModel(modelConfig, "other"), "gpt-4o-mini", "default model");

// --- Test v1 migration ---
// Write v1 format usage directly
const today = storage.today();
const v1Usage = {};
v1Usage[today] = { "legacyAgent": 9999 };
fs.writeFileSync(storage.USAGE_PATH, JSON.stringify(v1Usage));
const migrated = storage.readUsage();
assert.deepEqual(migrated[today]["legacyAgent"], { input: 0, output: 9999 }, "v1 migration");

// --- Test 90-day pruning ---
// Write an entry with an old date
const oldDate = "2025-01-01";
const usageWithOld = storage.readUsage();
usageWithOld[oldDate] = { "oldAgent": { input: 100, output: 200 } };
fs.writeFileSync(storage.USAGE_PATH, JSON.stringify(usageWithOld));
// Trigger pruning via addUsage
storage.addUsage("pruneTest", 1, 1);
const afterPrune = storage.readUsage();
assert.equal(afterPrune[oldDate], undefined, "old entry pruned");
assert.ok(afterPrune[today], "today entry preserved");

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("storage.test.js: all tests passed");
