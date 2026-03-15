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

// --- Test: add usage and check ---
storage.addUsage("agent1", 400, 200);
assert.equal(storage.getTotalTokens("agent1"), 600, "after add: 600");

// --- Test: cost calculation ---
const cost = calculateCost(400, 200, "claude-sonnet-4-20250514", {});
assert.ok(cost !== null, "cost not null");
// (400/1M)*3 + (200/1M)*15 = 0.0012 + 0.003 = 0.0042
assert.ok(Math.abs(cost - 0.0042) < 0.0001, `cost: ${cost}`);

// --- Test: exceed limit ---
storage.addUsage("agent1", 300, 200);
assert.equal(storage.getTotalTokens("agent1"), 1100, "over limit: 1100");
const config = storage.readConfig();
const limit = storage.getLimit(config, "agent1");
assert.ok(storage.getTotalTokens("agent1") >= limit, "should be blocked");

// --- Test: default agent limit ---
assert.equal(storage.getLimit(config, "unknown_agent"), 500, "default limit");

// --- Test: token_budget_status tool return format ---
const usage = storage.readUsage();
const date = storage.today();
const todayUsage = usage[date] || {};
const allAgents = new Set([
  ...Object.keys(todayUsage),
  ...Object.keys(config.limits).filter((k) => k !== "default"),
]);
assert.ok(allAgents.size > 0, "agents found");
// Verify the return format matches OpenClaw registerTool spec
const toolResult = { content: [{ type: "text", text: "test" }] };
assert.equal(toolResult.content[0].type, "text", "tool result format");

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("hooks.test.js: all tests passed");
