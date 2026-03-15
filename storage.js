// storage.js — usage & config I/O with cache-aware token tracking
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
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

// Migrate older formats:
// v1: { "date": { "agent": number } } → number becomes output
// v2: { "date": { "agent": { input, output, cost } } } → add cacheRead/cacheWrite=0
function migrateUsage(usage) {
  let migrated = false;
  for (const date of Object.keys(usage)) {
    for (const agent of Object.keys(usage[date])) {
      const val = usage[date][agent];
      if (typeof val === "number") {
        usage[date][agent] = { ...EMPTY_USAGE, output: val };
        migrated = true;
      } else if (val && typeof val === "object" && val.cacheRead === undefined) {
        // v2 format: has input/output but no cache fields
        usage[date][agent] = {
          input: val.input || 0,
          output: val.output || 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: val.cost || 0,
        };
        migrated = true;
      }
    }
  }
  return migrated;
}

function readUsage() {
  const usage = readJSON(USAGE_PATH, {});
  if (migrateUsage(usage)) {
    writeJSON(USAGE_PATH, usage);
  }
  return usage;
}

function pruneOldEntries(usage) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const y = cutoff.getFullYear();
  const m = String(cutoff.getMonth() + 1).padStart(2, "0");
  const day = String(cutoff.getDate()).padStart(2, "0");
  const cutoffStr = `${y}-${m}-${day}`;
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
  const a = usage[date] && usage[date][agentId];
  if (!a) return { ...EMPTY_USAGE };
  return {
    input: a.input || 0,
    output: a.output || 0,
    cacheRead: a.cacheRead || 0,
    cacheWrite: a.cacheWrite || 0,
    cost: a.cost || 0,
  };
}

// Effective tokens = input + output (what the user controls)
function getTotalTokens(agentId) {
  const u = getUsage(agentId);
  return u.input + u.output;
}

function addUsage(agentId, input, output, cacheRead, cacheWrite, costUsd) {
  let usage = readUsage();
  const date = today();
  if (!usage[date]) usage[date] = {};
  if (!usage[date][agentId]) usage[date][agentId] = { ...EMPTY_USAGE };
  usage[date][agentId].input += input;
  usage[date][agentId].output += output;
  usage[date][agentId].cacheRead += cacheRead || 0;
  usage[date][agentId].cacheWrite += cacheWrite || 0;
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
  CONFIG_PATH, USAGE_PATH, DATA_DIR, EMPTY_USAGE,
};
