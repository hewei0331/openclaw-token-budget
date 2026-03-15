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
  if (!agentData) return { input: 0, output: 0, cost: 0 };
  return {
    input: agentData.input || 0,
    output: agentData.output || 0,
    cost: agentData.cost || 0,
  };
}

function getTotalTokens(agentId) {
  const u = getUsage(agentId);
  return u.input + u.output;
}

function addUsage(agentId, inputTokens, outputTokens, costUsd) {
  let usage = readUsage();
  const date = today();
  if (!usage[date]) usage[date] = {};
  if (!usage[date][agentId]) usage[date][agentId] = { input: 0, output: 0, cost: 0 };
  usage[date][agentId].input += inputTokens;
  usage[date][agentId].output += outputTokens;
  usage[date][agentId].cost += costUsd || 0;
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
