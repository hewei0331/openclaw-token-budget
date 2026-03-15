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
storage.addUsage("testAgent", 100, 50, 10, 5000, 0.005);
const usage = storage.getUsage("testAgent");
assert.equal(usage.input, 100, "input");
assert.equal(usage.output, 50, "output");
assert.equal(usage.cacheRead, 10, "cacheRead");
assert.equal(usage.cacheWrite, 5000, "cacheWrite");
assert.equal(usage.cost, 0.005, "cost");

// --- Test getTotalTokens returns effective only (input + output) ---
assert.equal(storage.getTotalTokens("testAgent"), 150, "effective total");

// --- Test addUsage accumulates ---
storage.addUsage("testAgent", 200, 100, 20, 0, 0.01);
const usage2 = storage.getUsage("testAgent");
assert.equal(usage2.input, 300, "accumulated input");
assert.equal(usage2.output, 150, "accumulated output");
assert.equal(usage2.cacheRead, 30, "accumulated cacheRead");
assert.equal(usage2.cacheWrite, 5000, "accumulated cacheWrite (no new write)");
assert.ok(Math.abs(usage2.cost - 0.015) < 0.0001, "accumulated cost");

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
const today = storage.today();
const v1Usage = {};
v1Usage[today] = { "legacyAgent": 9999 };
fs.writeFileSync(storage.USAGE_PATH, JSON.stringify(v1Usage));
const migrated = storage.readUsage();
assert.deepEqual(migrated[today]["legacyAgent"], { input: 0, output: 9999, cacheRead: 0, cacheWrite: 0, cost: 0 }, "v1 migration");

// --- Test v2 migration (no cache fields) ---
const v2Usage = {};
v2Usage[today] = { "v2Agent": { input: 100, output: 200, cost: 0.05 } };
fs.writeFileSync(storage.USAGE_PATH, JSON.stringify(v2Usage));
const migratedV2 = storage.readUsage();
assert.deepEqual(migratedV2[today]["v2Agent"], { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.05 }, "v2 migration");

// --- Test 90-day pruning ---
const oldDate = "2025-01-01";
const usageWithOld = storage.readUsage();
usageWithOld[oldDate] = { "oldAgent": { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0 } };
fs.writeFileSync(storage.USAGE_PATH, JSON.stringify(usageWithOld));
storage.addUsage("pruneTest", 1, 1, 0, 0, 0);
const afterPrune = storage.readUsage();
assert.equal(afterPrune[oldDate], undefined, "old entry pruned");
assert.ok(afterPrune[today], "today entry preserved");

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("storage.test.js: all tests passed");
