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
      let costUsd = 0;

      if (event.messages && Array.isArray(event.messages)) {
        for (let i = event.messages.length - 1; i >= 0; i--) {
          const msg = event.messages[i];
          if (msg.role === "assistant" && msg.usage) {
            // OpenClaw usage: { input, output, cacheRead, cacheWrite, totalTokens, cost: { total } }
            inputTokens = (msg.usage.input || 0) + (msg.usage.cacheRead || 0) + (msg.usage.cacheWrite || 0);
            outputTokens = msg.usage.output || 0;
            // Use OpenClaw's pre-calculated cost (accounts for cache pricing tiers)
            if (msg.usage.cost && typeof msg.usage.cost.total === "number") {
              costUsd = msg.usage.cost.total;
            }
            break;
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
            outputTokens = text.length;
            break;
          }
        }
      }

      if (inputTokens > 0 || outputTokens > 0) {
        addUsage(agentId, inputTokens, outputTokens, costUsd);
        api.logger.info(
          `[token-budget] ${agentId} +${inputTokens}in/${outputTokens}out $${costUsd.toFixed(4)} (total today: ${getTotalTokens(agentId)})`
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
          const u = todayUsage[agent] || { input: 0, output: 0, cost: 0 };
          const total = (u.input || 0) + (u.output || 0);
          const limit = getLimit(config, agent);
          const model = getModel(config, agent);
          const costUsd = u.cost || 0;
          const costCny = costUsd * config.exchangeRate;
          const pct = limit > 0 ? Math.round((total / limit) * 100) : 0;
          const bar = limit > 0 ? `${pct}%` : "no limit";
          const costStr = ` | $${costUsd.toFixed(4)} / ¥${costCny.toFixed(4)}`;
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
        const u = todayUsage[id] || { input: 0, output: 0, cost: 0 };
        const limit = getLimit(config, id);
        const model = getModel(config, id);
        const costUsd = u.cost || 0;
        agents[id] = {
          input: u.input || 0,
          output: u.output || 0,
          total: (u.input || 0) + (u.output || 0),
          limit,
          model,
          costUsd,
          costCny: costUsd * config.exchangeRate,
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
          const costUsd = u.cost || 0;
          report[dateStr][agentId] = {
            input: u.input || 0,
            output: u.output || 0,
            total: (u.input || 0) + (u.output || 0),
            model,
            costUsd,
            costCny: costUsd * config.exchangeRate,
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
