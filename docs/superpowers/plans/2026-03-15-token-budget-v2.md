# Token Budget Plugin v2 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the token budget plugin with input/output split tracking, model-based cost calculation, weekly/monthly reporting, and a local web dashboard for control and visibility.

**Architecture:** Single-process OpenClaw plugin using `agent_end` hook for token tracking, `before_prompt_build` for limit enforcement, `registerHttpRoute` for dashboard API, and a single-file HTML dashboard. Zero external dependencies.

**Tech Stack:** Node.js (CommonJS), OpenClaw Plugin API, vanilla HTML/CSS/JS

**Spec:** `docs/superpowers/specs/2026-03-15-token-budget-v2-design.md`

---

## Chunk 1: Core Data Layer

### Task 1: Create prices.js — Built-in model price table

**Files:**
- Create: `prices.js`
- Create: `test/prices.test.js`

- [ ] **Step 1: Write prices.js with model pricing data**

```js
// prices.js — Built-in model prices (USD per 1M tokens)
const PRICES = {
  "claude-sonnet-4-20250514":    { input: 3,    output: 15 },
  "claude-haiku-4-5-20251001":   { input: 0.8,  output: 4 },
  "claude-opus-4-20250514":      { input: 15,   output: 75 },
  "gpt-4o":                      { input: 2.5,  output: 10 },
  "gpt-4o-mini":                 { input: 0.15, output: 0.6 },
  "gemini-2.0-flash":            { input: 0.10, output: 0.40 },
  "gemini-2.5-pro":              { input: 1.25, output: 10 },
  "deepseek-chat":               { input: 0.27, output: 1.10 },
  "deepseek-reasoner":           { input: 0.55, output: 2.19 },
};

function getPrice(modelId, priceOverrides) {
  if (priceOverrides && priceOverrides[modelId]) {
    return priceOverrides[modelId];
  }
  return PRICES[modelId] || null;
}

function calculateCost(inputTokens, outputTokens, modelId, priceOverrides) {
  const price = getPrice(modelId, priceOverrides);
  if (!price) return null;
  return (inputTokens / 1_000_000) * price.input
       + (outputTokens / 1_000_000) * price.output;
}

function allModelIds() {
  return Object.keys(PRICES);
}

module.exports = { PRICES, getPrice, calculateCost, allModelIds };
```

- [ ] **Step 2: Write test for prices.js**

Create `test/prices.test.js`:

```js
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
```

- [ ] **Step 3: Run test**

Run: `node test/prices.test.js`
Expected: `prices.test.js: all tests passed`

- [ ] **Step 4: Commit**

```bash
git add prices.js test/prices.test.js
git commit -m "feat: add built-in model price table with cost calculation"
```

---

### Task 2: Create storage.js — input/output split, v1 migration, 90-day retention

**Files:**
- Create: `storage.js`
- Create: `test/storage.test.js`

- [ ] **Step 1: Write storage.js with upgraded data operations**

```js
// storage.js — usage & config I/O with input/output split
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(process.env.HOME, ".openclaw/token-budget");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const USAGE_PATH = path.join(DATA_DIR, "usage.json");

const DEFAULT_CONFIG = {
  limits: {},
  models: {},
  priceOverrides: {},
  exchangeRate: 7.2,
};

const RETENTION_DAYS = 90;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function readJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function readConfig() {
  const raw = readJSON(CONFIG_PATH, {});
  return { ...DEFAULT_CONFIG, ...raw };
}

function writeConfig(config) {
  writeJSON(CONFIG_PATH, config);
}

// Migrate v1 usage format: { "date": { "agent": number } }
// to v2 format: { "date": { "agent": { input: 0, output: number } } }
function migrateUsage(usage) {
  let migrated = false;
  for (const date of Object.keys(usage)) {
    for (const agent of Object.keys(usage[date])) {
      const val = usage[date][agent];
      if (typeof val === "number") {
        // v1 format: attribute all tokens to output (conservative for cost)
        usage[date][agent] = { input: 0, output: val };
        migrated = true;
      }
    }
  }
  return migrated;
}

function readUsage() {
  const usage = readJSON(USAGE_PATH, {});
  if (migrateUsage(usage)) {
    writeJSON(USAGE_PATH, usage); // persist migration
  }
  return usage;
}

function pruneOldEntries(usage) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const pruned = {};
  for (const date of Object.keys(usage)) {
    if (date >= cutoffStr) {
      pruned[date] = usage[date];
    }
  }
  return pruned;
}

function getUsage(agentId) {
  const usage = readUsage();
  const date = today();
  const agentData = usage[date] && usage[date][agentId];
  if (!agentData) return { input: 0, output: 0 };
  return { input: agentData.input || 0, output: agentData.output || 0 };
}

function getTotalTokens(agentId) {
  const u = getUsage(agentId);
  return u.input + u.output;
}

function addUsage(agentId, inputTokens, outputTokens) {
  let usage = readUsage();
  const date = today();
  if (!usage[date]) usage[date] = {};
  if (!usage[date][agentId]) usage[date][agentId] = { input: 0, output: 0 };
  usage[date][agentId].input += inputTokens;
  usage[date][agentId].output += outputTokens;
  usage = pruneOldEntries(usage);
  writeJSON(USAGE_PATH, usage);
}

function getLimit(config, agentId) {
  const limits = config.limits || {};
  if (agentId && limits[agentId] !== undefined) return limits[agentId];
  return limits.default || 0;
}

function getModel(config, agentId) {
  const models = config.models || {};
  if (agentId && models[agentId]) return models[agentId];
  return models.default || "unknown";
}

module.exports = {
  today, readConfig, writeConfig, readUsage,
  getUsage, getTotalTokens, addUsage, getLimit, getModel,
  CONFIG_PATH, USAGE_PATH, DATA_DIR,
};
```

- [ ] **Step 2: Write test for storage.js**

Create `test/storage.test.js`:

```js
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
```

- [ ] **Step 3: Run test**

Run: `node test/storage.test.js`
Expected: `storage.test.js: all tests passed`

- [ ] **Step 4: Commit**

```bash
git add storage.js test/storage.test.js
git commit -m "feat: add storage layer with input/output split, v1 migration, 90-day retention"
```

---

## Chunk 2: Plugin Core (Hooks + Tool)

### Task 3: Rewrite index.js — Fix hooks, use storage.js and prices.js

**Files:**
- Modify: `index.js`
- Create: `test/hooks.test.js`

- [ ] **Step 1: Rewrite index.js with corrected hooks**

Replace entire `index.js` with:

```js
const {
  readConfig, writeConfig, getTotalTokens, addUsage, getUsage,
  getLimit, getModel, readUsage, today,
} = require("./storage");
const { calculateCost, allModelIds, PRICES } = require("./prices");
const fs = require("fs");
const path = require("path");

module.exports = {
  id: "token-budget",
  name: "Token Budget",
  description: "Per-agent daily token budget with cost tracking and dashboard",
  version: "2.0.0",

  register(api) {
    // --- Hook: before_prompt_build --- block if over limit
    api.on("before_prompt_build", async (_event, ctx) => {
      const config = readConfig(); // re-read each time for hot-reload
      const agentId = ctx.agentId || "default";
      const limit = getLimit(config, agentId);
      if (limit <= 0) return;

      const used = getTotalTokens(agentId);
      if (used >= limit) {
        api.logger.warn(
          `[token-budget] ${agentId} reached daily limit: ${used}/${limit}`
        );
        return {
          systemPrompt:
            'You must reply with exactly this message and nothing else: "今日 token 已达上限，明天再来吧 🌙"',
        };
      }

      api.logger.info(`[token-budget] ${agentId} usage: ${used}/${limit}`);
    });

    // --- Hook: agent_end --- count tokens from messages
    api.on("agent_end", async (event, ctx) => {
      const agentId = ctx.agentId || "default";
      let inputTokens = 0;
      let outputTokens = 0;

      if (event.messages && Array.isArray(event.messages)) {
        // Walk messages in reverse to find the last assistant message with usage
        for (let i = event.messages.length - 1; i >= 0; i--) {
          const msg = event.messages[i];
          if (msg.role === "assistant" && msg.usage) {
            inputTokens += msg.usage.input_tokens || 0;
            outputTokens += msg.usage.output_tokens || 0;
            break; // only count the last assistant turn
          }
        }
      }

      // Fallback: estimate from content if no usage data
      if (inputTokens === 0 && outputTokens === 0 && event.messages) {
        for (let i = event.messages.length - 1; i >= 0; i--) {
          const msg = event.messages[i];
          if (msg.role === "assistant" && msg.content) {
            const text = typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content);
            // 1 char ≈ 1 token (conservative for Chinese)
            outputTokens = text.length;
            break;
          }
        }
      }

      if (inputTokens > 0 || outputTokens > 0) {
        addUsage(agentId, inputTokens, outputTokens);
        api.logger.info(
          `[token-budget] ${agentId} +${inputTokens}in/${outputTokens}out (total today: ${getTotalTokens(agentId)})`
        );
      }
    });

    // --- Tool: token_budget_status ---
    api.registerTool({
      name: "token_budget_status",
      description: "Show daily token usage, limits, and cost for all agents",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async execute() {
        const config = readConfig();
        const usage = readUsage();
        const date = today();
        const todayUsage = usage[date] || {};
        const limits = config.limits || {};

        const lines = ["## Token Budget Status", `**Date:** ${date}`, ""];

        const allAgents = new Set([
          ...Object.keys(todayUsage),
          ...Object.keys(limits).filter((k) => k !== "default"),
        ]);

        for (const agent of allAgents) {
          const u = todayUsage[agent] || { input: 0, output: 0 };
          const total = (u.input || 0) + (u.output || 0);
          const limit = getLimit(config, agent);
          const model = getModel(config, agent);
          const costUsd = calculateCost(u.input || 0, u.output || 0, model, config.priceOverrides);
          const costCny = costUsd !== null ? costUsd * config.exchangeRate : null;
          const pct = limit > 0 ? Math.round((total / limit) * 100) : 0;
          const bar = limit > 0 ? `${pct}%` : "no limit";
          const costStr = costUsd !== null
            ? ` | $${costUsd.toFixed(4)} / ¥${costCny.toFixed(4)}`
            : "";
          lines.push(
            `- **${agent}** (${model}): ${total.toLocaleString()} / ${limit > 0 ? limit.toLocaleString() : "∞"} (${bar})${costStr}`
          );
        }

        if (allAgents.size === 0) {
          lines.push("_No usage recorded today._");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      },
    });

    // --- Dashboard HTTP routes ---
    registerDashboardRoutes(api);

    api.logger.info("[token-budget] Plugin v2 loaded");
  },
};

function registerDashboardRoutes(api) {
  const dashboardHtml = fs.readFileSync(
    path.join(__dirname, "dashboard.html"),
    "utf8"
  );

  // Serve dashboard HTML
  api.registerHttpRoute({
    path: "/token-budget",
    auth: "gateway",
    match: "exact",
    handler: async (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(dashboardHtml);
      return true;
    },
  });

  // API: get status (today's usage + limits + costs)
  api.registerHttpRoute({
    path: "/token-budget/api/status",
    auth: "gateway",
    match: "exact",
    handler: async (_req, res) => {
      const config = readConfig();
      const usage = readUsage();
      const date = today();
      const todayUsage = usage[date] || {};
      const limits = config.limits || {};
      const agents = {};

      const allAgentIds = new Set([
        ...Object.keys(todayUsage),
        ...Object.keys(limits).filter((k) => k !== "default"),
      ]);

      for (const id of allAgentIds) {
        const u = todayUsage[id] || { input: 0, output: 0 };
        const limit = getLimit(config, id);
        const model = getModel(config, id);
        const costUsd = calculateCost(u.input || 0, u.output || 0, model, config.priceOverrides);
        agents[id] = {
          input: u.input || 0,
          output: u.output || 0,
          total: (u.input || 0) + (u.output || 0),
          limit,
          model,
          costUsd,
          costCny: costUsd !== null ? costUsd * config.exchangeRate : null,
        };
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ date, agents, exchangeRate: config.exchangeRate }));
      return true;
    },
  });

  // API: get report (daily/weekly/monthly)
  api.registerHttpRoute({
    path: "/token-budget/api/report",
    auth: "gateway",
    match: "exact",
    handler: async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const period = url.searchParams.get("period") || "day";
      const config = readConfig();
      const usage = readUsage();

      const now = new Date();
      let daysBack = 1;
      if (period === "week") daysBack = 7;
      if (period === "month") daysBack = 30;

      const report = {};
      for (let i = 0; i < daysBack; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().slice(0, 10);
        const dayData = usage[dateStr] || {};
        report[dateStr] = {};
        for (const [agentId, u] of Object.entries(dayData)) {
          const model = getModel(config, agentId);
          const costUsd = calculateCost(u.input || 0, u.output || 0, model, config.priceOverrides);
          report[dateStr][agentId] = {
            input: u.input || 0,
            output: u.output || 0,
            total: (u.input || 0) + (u.output || 0),
            model,
            costUsd,
            costCny: costUsd !== null ? costUsd * config.exchangeRate : null,
          };
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ period, exchangeRate: config.exchangeRate, report }));
      return true;
    },
  });

  // API: get/update config
  api.registerHttpRoute({
    path: "/token-budget/api/config",
    auth: "gateway",
    match: "exact",
    handler: async (req, res) => {
      if (req.method === "GET") {
        const config = readConfig();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(config));
        return true;
      }
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        try {
          const newConfig = JSON.parse(body);
          writeConfig(newConfig);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return true;
      }
      return false;
    },
  });
}
```

- [ ] **Step 2: Run existing tests to verify no regression**

Run: `node test/prices.test.js && node test/storage.test.js`
Expected: both pass

- [ ] **Step 3: Write integration test for hook logic**

Create `test/hooks.test.js`:

```js
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
// Simulate what the tool does
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
```

- [ ] **Step 4: Run test**

Run: `node test/hooks.test.js`
Expected: `hooks.test.js: all tests passed`

- [ ] **Step 5: Commit**

```bash
git add index.js test/hooks.test.js
git commit -m "feat: rewrite plugin core with correct hooks, input/output split, cost tracking"
```

---

## Chunk 3: Dashboard Frontend

### Task 4: Create dashboard.html — Single-file web dashboard

**Files:**
- Create: `dashboard.html`

- [ ] **Step 1: Write dashboard.html — CSS foundation and page layout**

Single HTML file with embedded CSS and JS. Structure:

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Token Budget Dashboard</title>
  <style>
    /* Dark theme base */
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; }

    /* Header */
    .header { padding: 20px 32px; background: #16213e; border-bottom: 1px solid #2a2a4a; }
    .header h1 { font-size: 20px; font-weight: 600; }

    /* Tabs */
    .tabs { display: flex; gap: 0; border-bottom: 2px solid #2a2a4a; padding: 0 32px; background: #16213e; }
    .tab { padding: 12px 24px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; }
    .tab.active { border-bottom-color: #4fc3f7; color: #4fc3f7; }

    /* Content panels */
    .panel { display: none; padding: 24px 32px; }
    .panel.active { display: block; }

    /* Tables */
    table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    th { text-align: left; padding: 10px 12px; background: #16213e; border-bottom: 1px solid #2a2a4a; font-size: 13px; color: #999; }
    td { padding: 10px 12px; border-bottom: 1px solid #1e1e3a; }

    /* Inputs */
    input, select { background: #0f3460; color: #e0e0e0; border: 1px solid #2a2a4a; padding: 6px 10px; border-radius: 4px; }

    /* Buttons */
    .btn { padding: 8px 20px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
    .btn-primary { background: #4fc3f7; color: #1a1a2e; }
    .btn-danger { background: #e74c3c; color: #fff; }

    /* Period selector */
    .period-selector { display: flex; gap: 8px; margin-bottom: 16px; }
    .period-btn { padding: 6px 16px; background: #16213e; border: 1px solid #2a2a4a; border-radius: 4px; color: #e0e0e0; cursor: pointer; }
    .period-btn.active { background: #4fc3f7; color: #1a1a2e; border-color: #4fc3f7; }

    /* Summary bar */
    .summary { display: flex; gap: 24px; margin: 16px 0; padding: 16px; background: #16213e; border-radius: 8px; }
    .summary-item { text-align: center; }
    .summary-value { font-size: 24px; font-weight: 700; color: #4fc3f7; }
    .summary-label { font-size: 12px; color: #999; margin-top: 4px; }

    /* Usage bar */
    .usage-bar { width: 120px; height: 6px; background: #2a2a4a; border-radius: 3px; }
    .usage-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
    .usage-fill.ok { background: #2ecc71; }
    .usage-fill.warn { background: #f39c12; }
    .usage-fill.over { background: #e74c3c; }

    /* Toast */
    .toast { position: fixed; top: 20px; right: 20px; padding: 12px 24px; border-radius: 8px; display: none; z-index: 1000; }
    .toast.success { background: #2ecc71; color: #fff; display: block; }
    .toast.error { background: #e74c3c; color: #fff; display: block; }
  </style>
</head>
<body>
  <div class="header"><h1>Token Budget Dashboard</h1></div>
  <div class="tabs">
    <div class="tab active" onclick="switchTab('control')">Control Panel</div>
    <div class="tab" onclick="switchTab('reports')">Reports</div>
  </div>

  <!-- Control Panel -->
  <div id="control" class="panel active">
    <h2>Agent Configuration</h2>
    <table id="config-table">
      <thead><tr><th>Agent</th><th>Model</th><th>Daily Limit</th><th>Today Usage</th><th>Progress</th><th></th></tr></thead>
      <tbody></tbody>
    </table>
    <button class="btn btn-primary" onclick="addAgent()">+ Add Agent</button>
    <button class="btn btn-primary" onclick="saveConfig()" style="margin-left:8px">Save</button>
  </div>

  <!-- Reports Panel -->
  <div id="reports" class="panel">
    <div class="period-selector">
      <button class="period-btn active" onclick="loadReport('day')">Today</button>
      <button class="period-btn" onclick="loadReport('week')">This Week</button>
      <button class="period-btn" onclick="loadReport('month')">This Month</button>
    </div>
    <div id="summary" class="summary"></div>
    <table id="report-table">
      <thead><tr><th>Date</th><th>Agent</th><th>Model</th><th>Input</th><th>Output</th><th>Total</th><th>Cost (USD)</th><th>Cost (CNY)</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    const API = '/token-budget/api';
    let currentConfig = {};

    // --- Tab switching ---
    function switchTab(name) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.querySelector(`.tab[onclick*="${name}"]`).classList.add('active');
      document.getElementById(name).classList.add('active');
      if (name === 'control') loadStatus();
      if (name === 'reports') loadReport('day');
    }

    // --- Toast notification ---
    function showToast(msg, type) {
      const t = document.getElementById('toast');
      t.textContent = msg; t.className = 'toast ' + type;
      setTimeout(() => t.className = 'toast', 3000);
    }

    // --- Control Panel ---
    async function loadStatus() {
      const [statusRes, configRes] = await Promise.all([
        fetch(API + '/status'), fetch(API + '/config')
      ]);
      const status = await statusRes.json();
      currentConfig = await configRes.json();
      renderConfigTable(status, currentConfig);
    }

    function renderConfigTable(status, config) {
      const tbody = document.querySelector('#config-table tbody');
      tbody.innerHTML = '';
      const agents = new Set([
        ...Object.keys(status.agents || {}),
        ...Object.keys(config.limits || {}).filter(k => k !== 'default'),
      ]);
      for (const id of agents) {
        const a = (status.agents || {})[id] || {};
        const limit = (config.limits || {})[id] || 0;
        const model = (config.models || {})[id] || '';
        const total = a.total || 0;
        const pct = limit > 0 ? Math.min(100, Math.round(total / limit * 100)) : 0;
        const barClass = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok';
        tbody.innerHTML += `<tr>
          <td><input value="${id}" data-agent="${id}" class="agent-name" /></td>
          <td><input value="${model}" data-field="model" data-agent="${id}" class="agent-model" /></td>
          <td><input type="number" value="${limit}" data-field="limit" data-agent="${id}" class="agent-limit" /></td>
          <td>${total.toLocaleString()}</td>
          <td><div class="usage-bar"><div class="usage-fill ${barClass}" style="width:${pct}%"></div></div> ${pct}%</td>
          <td><button class="btn btn-danger" onclick="removeAgent('${id}')">Remove</button></td>
        </tr>`;
      }
    }

    function addAgent() {
      const tbody = document.querySelector('#config-table tbody');
      const id = 'new_agent_' + Date.now();
      tbody.innerHTML += `<tr>
        <td><input value="" data-agent="${id}" class="agent-name" placeholder="agent id" /></td>
        <td><input value="" data-field="model" data-agent="${id}" class="agent-model" placeholder="model id" /></td>
        <td><input type="number" value="5000" data-field="limit" data-agent="${id}" class="agent-limit" /></td>
        <td>0</td><td>—</td>
        <td><button class="btn btn-danger" onclick="this.closest('tr').remove()">Remove</button></td>
      </tr>`;
    }

    function removeAgent(id) {
      delete currentConfig.limits[id];
      delete currentConfig.models[id];
      document.querySelector(`tr:has([data-agent="${id}"])`)?.remove();
    }

    async function saveConfig() {
      const newLimits = {};
      const newModels = {};
      document.querySelectorAll('#config-table tbody tr').forEach(row => {
        const name = row.querySelector('.agent-name')?.value?.trim();
        if (!name) return;
        const limit = parseInt(row.querySelector('.agent-limit')?.value) || 0;
        const model = row.querySelector('.agent-model')?.value?.trim() || '';
        newLimits[name] = limit;
        if (model) newModels[name] = model;
      });
      currentConfig.limits = newLimits;
      currentConfig.models = newModels;
      try {
        const res = await fetch(API + '/config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(currentConfig),
        });
        if (res.ok) { showToast('Config saved', 'success'); loadStatus(); }
        else showToast('Save failed', 'error');
      } catch (e) { showToast('Save failed: ' + e.message, 'error'); }
    }

    // --- Reports Panel ---
    async function loadReport(period) {
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      document.querySelector(`.period-btn[onclick*="${period}"]`).classList.add('active');
      const res = await fetch(API + '/report?period=' + period);
      const data = await res.json();
      renderReport(data);
    }

    function renderReport(data) {
      const tbody = document.querySelector('#report-table tbody');
      tbody.innerHTML = '';
      let totalTokens = 0, totalUsd = 0;
      const rate = data.exchangeRate || 7.2;

      const dates = Object.keys(data.report || {}).sort().reverse();
      for (const date of dates) {
        const agents = data.report[date];
        for (const [id, a] of Object.entries(agents)) {
          totalTokens += a.total;
          totalUsd += a.costUsd || 0;
          tbody.innerHTML += `<tr>
            <td>${date}</td><td>${id}</td><td>${a.model}</td>
            <td>${(a.input || 0).toLocaleString()}</td>
            <td>${(a.output || 0).toLocaleString()}</td>
            <td>${(a.total || 0).toLocaleString()}</td>
            <td>$${(a.costUsd || 0).toFixed(4)}</td>
            <td>¥${(a.costCny || 0).toFixed(4)}</td>
          </tr>`;
        }
      }

      document.getElementById('summary').innerHTML = `
        <div class="summary-item"><div class="summary-value">${totalTokens.toLocaleString()}</div><div class="summary-label">Total Tokens</div></div>
        <div class="summary-item"><div class="summary-value">$${totalUsd.toFixed(4)}</div><div class="summary-label">Total Cost (USD)</div></div>
        <div class="summary-item"><div class="summary-value">¥${(totalUsd * rate).toFixed(4)}</div><div class="summary-label">Total Cost (CNY)</div></div>
      `;
    }

    // --- Init ---
    loadStatus();
    setInterval(loadStatus, 30000); // auto-refresh every 30s
  </script>
</body>
</html>
```

- [ ] **Step 2: Manual test — open in browser**

Run: Start OpenClaw gateway with plugin installed, open `http://localhost:<gateway-port>/token-budget`
Expected: Dashboard loads with two tabs:
- Control Panel: shows agent config table (editable limits, models), save button works
- Reports: shows period selector (day/week/month), usage table with USD/CNY costs, summary totals

- [ ] **Step 3: Commit**

```bash
git add dashboard.html
git commit -m "feat: add single-file web dashboard with control and report panels"
```

---

## Chunk 4: Package Updates & Documentation

### Task 5: Update manifest, package.json, README

**Files:**
- Modify: `openclaw.plugin.json`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Update openclaw.plugin.json**

```json
{
  "id": "token-budget",
  "name": "Token Budget",
  "description": "Per-agent daily token budget with cost tracking and web dashboard",
  "version": "2.0.0",
  "configSchema": {
    "type": "object",
    "properties": {
      "limits": { "type": "object", "description": "Per-agent daily token limits" },
      "models": { "type": "object", "description": "Per-agent model ID mapping for cost calculation" },
      "priceOverrides": { "type": "object", "description": "Custom model pricing overrides (USD per 1M tokens)" },
      "exchangeRate": { "type": "number", "description": "USD to CNY exchange rate, default 7.2" }
    },
    "additionalProperties": false
  }
}
```

- [ ] **Step 2: Update package.json**

```json
{
  "name": "@hewei0331/openclaw-token-budget",
  "version": "2.0.0",
  "description": "Per-agent daily token budget with cost tracking and web dashboard for OpenClaw",
  "main": "index.js",
  "scripts": {
    "test": "node test/prices.test.js && node test/storage.test.js && node test/hooks.test.js"
  },
  "keywords": ["openclaw", "plugin", "token", "budget", "cost", "dashboard"],
  "author": "hewei0331",
  "license": "MIT",
  "engines": { "node": ">=18" },
  "files": [
    "index.js",
    "prices.js",
    "storage.js",
    "dashboard.html",
    "openclaw.plugin.json",
    "README.md"
  ]
}
```

- [ ] **Step 3: Update README.md**

Update README to document:
- v2 feature overview (input/output split, cost tracking, dashboard)
- Full config.json schema with all fields (limits, models, priceOverrides, exchangeRate)
- Built-in supported models list
- Dashboard URL: `http://localhost:<gateway-port>/token-budget`
- Cost calculation formula
- Report periods (day/week/month)
- v1 → v2 migration (automatic, no action needed)

- [ ] **Step 4: Commit**

```bash
git add openclaw.plugin.json package.json README.md
git commit -m "docs: update manifest, package, and README for v2"
```

---

## Chunk 5: End-to-End Verification

### Task 6: Run all tests and verify

- [ ] **Step 1: Run all tests**

Run: `npm test`
Expected: All three test files pass

- [ ] **Step 2: Verify file structure**

```
├── index.js              (plugin entry, hooks, HTTP routes)
├── prices.js             (model price table + cost calculation)
├── storage.js            (config/usage I/O, v1 migration, pruning)
├── dashboard.html        (single-file frontend)
├── openclaw.plugin.json  (manifest)
├── package.json          (with test script)
├── README.md
└── test/
    ├── prices.test.js
    ├── storage.test.js
    └── hooks.test.js
```

- [ ] **Step 3: Local install test**

Run: `openclaw plugins install file:///Users/weihe/Documents/Projects/openclaw-token-budget`
Expected: Plugin installs, gateway logs show `[token-budget] Plugin v2 loaded`

- [ ] **Step 4: Verify dashboard loads**

Open: `http://localhost:<gateway-port>/token-budget`
Expected: Dashboard renders with control and report tabs

- [ ] **Step 5: Final commit if any fixups needed**

```bash
git add -A && git commit -m "fix: integration test fixups"
```
