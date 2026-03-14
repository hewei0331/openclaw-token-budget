const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(
  process.env.HOME,
  ".openclaw/token-budget/config.json"
);
const USAGE_PATH = path.join(
  process.env.HOME,
  ".openclaw/token-budget/usage.json"
);

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

function getLimit(config, agentId) {
  const limits = config.limits || {};
  if (agentId && limits[agentId] !== undefined) return limits[agentId];
  return limits.default || 0;
}

function getUsage(agentId) {
  const usage = readJSON(USAGE_PATH, {});
  const date = today();
  return (usage[date] && usage[date][agentId]) || 0;
}

function addUsage(agentId, tokens) {
  const usage = readJSON(USAGE_PATH, {});
  const date = today();
  if (!usage[date]) usage[date] = {};
  usage[date][agentId] = (usage[date][agentId] || 0) + tokens;
  writeJSON(USAGE_PATH, usage);
}

module.exports = {
  id: "token-budget",
  name: "Token Budget",
  description: "Limits daily token usage per agent",
  version: "1.0.0",

  register(api) {
    const config = readJSON(CONFIG_PATH, { limits: {} });

    // Block requests when agent exceeds daily limit
    api.on("before_prompt_build", async (_event, ctx) => {
      const agentId = ctx.agentId || "default";
      const limit = getLimit(config, agentId);
      if (limit <= 0) return; // no limit

      const used = getUsage(agentId);
      if (used >= limit) {
        api.logger.warn(
          `[token-budget] ${agentId} reached daily limit: ${used}/${limit}`
        );
        return {
          systemPrompt:
            'You must reply with exactly this message and nothing else: "今日 token 已达上限，明天再来吧 🌙"',
        };
      }

      api.logger.info(
        `[token-budget] ${agentId} usage: ${used}/${limit}`
      );
    });

    // Track token usage after each LLM call
    api.on("llm_output", async (event, ctx) => {
      const agentId = ctx.agentId || "default";
      let tokens = 0;

      if (event.usage) {
        tokens = (event.usage.input || 0) + (event.usage.output || 0);
      } else if (event.assistantTexts) {
        // Fallback: estimate ~1 token per 4 chars
        const text = event.assistantTexts.join("");
        tokens = Math.ceil(text.length / 4);
      }

      if (tokens > 0) {
        addUsage(agentId, tokens);
        api.logger.info(
          `[token-budget] ${agentId} +${tokens} tokens (total today: ${getUsage(agentId)})`
        );
      }
    });

    // Register a tool to check current usage status
    api.registerTool({
      name: "token_budget_status",
      description:
        "Show daily token usage and limits for all agents",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      async execute() {
        const usage = readJSON(USAGE_PATH, {});
        const date = today();
        const todayUsage = usage[date] || {};
        const limits = config.limits || {};

        const lines = ["## Token Budget Status", `**Date:** ${date}`, ""];

        const allAgents = new Set([
          ...Object.keys(todayUsage),
          ...Object.keys(limits).filter((k) => k !== "default"),
        ]);

        for (const agent of allAgents) {
          const used = todayUsage[agent] || 0;
          const limit = getLimit(config, agent);
          const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
          const bar = limit > 0 ? `${pct}%` : "no limit";
          lines.push(`- **${agent}**: ${used.toLocaleString()} / ${limit > 0 ? limit.toLocaleString() : "∞"} (${bar})`);
        }

        if (allAgents.size === 0) {
          lines.push("_No usage recorded today._");
        }

        return lines.join("\n");
      },
    });

    api.logger.info("[token-budget] Plugin loaded");
  },
};
