const assert = require("node:assert/strict");
const { getPrice, calculateCost } = require("../prices");

// getPrice returns built-in price
const sonnetPrice = getPrice("claude-sonnet-4-20250514", {});
assert.equal(sonnetPrice.input, 3, "sonnet input price");
assert.equal(sonnetPrice.output, 15, "sonnet output price");

// getPrice respects overrides
const overridden = getPrice("claude-sonnet-4-20250514", {
  "claude-sonnet-4-20250514": { input: 5, output: 20 }
});
assert.equal(overridden.input, 5, "override input");

// getPrice returns null for unknown model
assert.equal(getPrice("unknown-model", {}), null, "unknown model");

// calculateCost computes correctly
// 1000 input + 500 output with sonnet pricing
// (1000/1M)*3 + (500/1M)*15 = 0.003 + 0.0075 = 0.0105
const cost = calculateCost(1000, 500, "claude-sonnet-4-20250514", {});
assert.ok(Math.abs(cost - 0.0105) < 0.0001, `cost calc: ${cost}`);

// calculateCost returns null for unknown model
assert.equal(calculateCost(1000, 500, "unknown", {}), null, "unknown cost");

console.log("prices.test.js: all tests passed");
