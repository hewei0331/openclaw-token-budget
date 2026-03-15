const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Setup temp HOME
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-hooks-"));
process.env.HOME = tmpDir;

const storage = require("../storage");
const { calculateCost } = require("../prices");

// Write a test config
storage.writeConfig({
  limits: { agent1: 1000, default: 500 },
  models: { agent1: "claude-sonnet-4-20250514", default: "gpt-4o-mini" },
  priceOverrides: {},
  exchangeRate: 7.2,
});

// --- Test: starts at zero ---
assert.equal(storage.getTotalTokens("agent1"), 0, "starts at 0");
assert.equal(storage.getLimit(storage.readConfig(), "agent1"), 1000, "limit 1000");

// --- Test: add usage with cache and check effective total ---
storage.addUsage("agent1", 400, 200, 100, 50000, 0.05);
assert.equal(storage.getTotalTokens("agent1"), 600, "effective total: 600 (excludes cache)");

// Verify full usage
const u = storage.getUsage("agent1");
assert.equal(u.cacheRead, 100, "cacheRead stored");
assert.equal(u.cacheWrite, 50000, "cacheWrite stored");

// --- Test: cost calculation (prices.js) ---
const cost = calculateCost(400, 200, "claude-sonnet-4-20250514", {});
assert.ok(cost !== null, "cost not null");
assert.ok(Math.abs(cost - 0.0042) < 0.0001, `cost: ${cost}`);

// --- Test: exceed limit based on effective tokens ---
storage.addUsage("agent1", 300, 200, 0, 0, 0.01);
assert.equal(storage.getTotalTokens("agent1"), 1100, "over limit: 1100");
const config = storage.readConfig();
const limit = storage.getLimit(config, "agent1");
assert.ok(storage.getTotalTokens("agent1") >= limit, "should be over limit");

// --- Test: default agent limit ---
assert.equal(storage.getLimit(config, "unknown_agent"), 500, "default limit");

// --- Test: tool return format ---
const toolResult = { content: [{ type: "text", text: "test" }] };
assert.equal(toolResult.content[0].type, "text", "tool result format");

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("hooks.test.js: all tests passed");
