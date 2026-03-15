const {
  readConfig, writeConfig, getTotalTokens, addUsage, getUsage,
  getLimit, getModel, readUsage, today, EMPTY_USAGE,
} = require("./storage");
const fs = require("fs");
const path = require("path");

module.exports = {
  id: "token-budget",
  name: "Token Budget",
  description: "Per-agent daily token budget with cost tracking and dashboard",
  version: "3.0.0",

  register(api) {
    // --- Hook: before_prompt_build --- log usage only (blocking disabled)
    api.on("before_prompt_build", async (_event, ctx) => {
      const config = readConfig();
      const agentId = ctx.agentId || "default";
      const limit = getLimit(config, agentId);
      const used = getTotalTokens(agentId);
      if (limit > 0) {
        api.logger.info(`[token-budget] ${agentId} usage: ${used}/${limit}`);
      }
    });

    // --- Hook: agent_end --- count tokens with cache breakdown
    api.on("agent_end", async (event, ctx) => {
      const agentId = ctx.agentId || "default";
      let input = 0;
      let output = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      let costUsd = 0;

      if (event.messages && Array.isArray(event.messages)) {
        for (let i = event.messages.length - 1; i >= 0; i--) {
          const msg = event.messages[i];
          if (msg.role === "assistant" && msg.usage) {
            input = msg.usage.input || 0;
            output = msg.usage.output || 0;
            cacheRead = msg.usage.cacheRead || 0;
            cacheWrite = msg.usage.cacheWrite || 0;
            if (msg.usage.cost && typeof msg.usage.cost.total === "number") {
              costUsd = msg.usage.cost.total;
            }
            break;
          }
        }
      }

      // Fallback: estimate from content if no usage data
      if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && event.messages) {
        for (let i = event.messages.length - 1; i >= 0; i--) {
          const msg = event.messages[i];
          if (msg.role === "assistant" && msg.content) {
            const text = typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content);
            output = text.length;
            break;
          }
        }
      }

      const total = input + output + cacheRead + cacheWrite;
      if (total > 0) {
        addUsage(agentId, input, output, cacheRead, cacheWrite, costUsd);
        const effective = input + output;
        const cache = cacheRead + cacheWrite;
        api.logger.info(
          `[token-budget] ${agentId} +${effective}(${input}in/${output}out) cache:${cache}(r${cacheRead}/w${cacheWrite}) $${costUsd.toFixed(4)}`
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
          const u = todayUsage[agent] || { ...EMPTY_USAGE };
          const effective = (u.input || 0) + (u.output || 0);
          const cache = (u.cacheRead || 0) + (u.cacheWrite || 0);
          const model = getModel(config, agent);
          const costUsd = u.cost || 0;
          const costCny = costUsd * config.exchangeRate;
          const costStr = `$${costUsd.toFixed(4)} / \u00a5${costCny.toFixed(4)}`;
          lines.push(
            `- **${agent}** (${model}): ${effective.toLocaleString()} effective + ${cache.toLocaleString()} cache | ${costStr}`
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

    api.logger.info("[token-budget] Plugin v3 loaded");
  },
};

function registerDashboardRoutes(api) {
  const dashboardHtml = fs.readFileSync(
    path.join(__dirname, "dashboard.html"),
    "utf8"
  );

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

  // API: status
  api.registerHttpRoute({
    path: "/token-budget/api/status",
    auth: "gateway",
    match: "exact",
    handler: async (_req, res) => {
      const config = readConfig();
      const usage = readUsage();
      const date = today();
      const todayUsage = usage[date] || {};
      const agents = {};

      const allAgentIds = new Set([
        ...Object.keys(todayUsage),
        ...Object.keys(config.limits || {}).filter((k) => k !== "default"),
      ]);

      for (const id of allAgentIds) {
        const u = todayUsage[id] || { ...EMPTY_USAGE };
        const costUsd = u.cost || 0;
        agents[id] = {
          input: u.input || 0,
          output: u.output || 0,
          cacheRead: u.cacheRead || 0,
          cacheWrite: u.cacheWrite || 0,
          effective: (u.input || 0) + (u.output || 0),
          cache: (u.cacheRead || 0) + (u.cacheWrite || 0),
          model: getModel(config, id),
          costUsd,
          costCny: costUsd * config.exchangeRate,
        };
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ date, agents, exchangeRate: config.exchangeRate }));
      return true;
    },
  });

  // API: report
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
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        const dateStr = `${y}-${m}-${day}`;
        const dayData = usage[dateStr] || {};
        report[dateStr] = {};
        for (const [agentId, u] of Object.entries(dayData)) {
          const costUsd = u.cost || 0;
          report[dateStr][agentId] = {
            input: u.input || 0,
            output: u.output || 0,
            cacheRead: u.cacheRead || 0,
            cacheWrite: u.cacheWrite || 0,
            effective: (u.input || 0) + (u.output || 0),
            cache: (u.cacheRead || 0) + (u.cacheWrite || 0),
            model: getModel(config, agentId),
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

  // API: config
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
