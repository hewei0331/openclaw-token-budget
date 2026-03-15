# Token Budget Plugin v2 — Design Spec

## Background

Michael runs 6 OpenClaw agents for his family (3 personal, wife 1, daughter 1, son 1), connected via TG/Feishu. He needs per-agent daily token budget enforcement, cost reporting (daily/weekly/monthly), and a local web dashboard for control and visibility.

## Design Decisions

### Data Structure

**config.json** (`~/.openclaw/token-budget/config.json`):
```json
{
  "limits": {
    "main": 50000,
    "stella": 10000,
    "default": 5000
  },
  "models": {
    "main": "claude-sonnet-4-20250514",
    "stella": "gpt-4o",
    "default": "claude-haiku-4-5-20251001"
  },
  "priceOverrides": {},
  "exchangeRate": 7.2
}
```

- `limits` — per-agent daily token ceiling (input + output combined). Note: agents on expensive models (e.g., Opus $15/$75) will cost more per token than cheap models (e.g., Haiku $0.80/$4) at the same limit. This is intentional — token limits are simpler and more predictable than fee-based limits. Cost is visible in reports so users can adjust limits accordingly.
- `models` — maps each agent to its model ID for cost calculation. This is a **manual config** that must match the agent's actual OpenClaw model setting. If OpenClaw's `agent_end` hook provides model info in the context or event, we prefer that at runtime and fall back to this config. Known limitation: if the model is changed in OpenClaw but not here, cost calculation will be inaccurate until updated.
- `priceOverrides` — override built-in model prices (same structure as price table entries)
- `exchangeRate` — USD→CNY conversion rate, default 7.2

**usage.json** (`~/.openclaw/token-budget/usage.json`):
```json
{
  "2026-03-14": {
    "main": { "input": 8000, "output": 4500 },
    "stella": { "input": 2000, "output": 1200 }
  }
}
```

Split input/output because model pricing differs significantly (e.g., Sonnet input $3/M vs output $15/M).

**v1 Migration:** v1 stored usage as `{ "date": { "agent": totalTokens } }` (flat number). On first read, if a value is a number instead of an object, convert it to `{ input: 0, output: value }` (attribute all legacy tokens to output for conservative cost estimation). This is a one-time, in-place migration.

### Built-in Price Table

USD per 1M tokens. User can override via `priceOverrides` in config.

```
claude-sonnet-4-20250514:    input $3,    output $15
claude-haiku-4-5-20251001:   input $0.8,  output $4
claude-opus-4-20250514:      input $15,   output $75
gpt-4o:                      input $2.5,  output $10
gpt-4o-mini:                 input $0.15, output $0.6
gemini-2.0-flash:            input $0.10, output $0.40
gemini-2.5-pro:              input $1.25, output $10
deepseek-chat:               input $0.27, output $1.10
deepseek-reasoner:           input $0.55, output $2.19
```

### Hook Corrections (from API research)

1. **`llm_output` does NOT exist** — use `agent_end` instead
2. **Token usage** is NOT `event.usage` — must extract from `event.messages`:
   - Walk `event.messages` in reverse
   - Find the last message with `role === "assistant"` AND `.usage` property
   - Read `.usage.input_tokens` and `.usage.output_tokens`
   - Only count the last assistant turn (not all messages) to avoid double-counting across hook invocations
   - If `event.messages` is empty/undefined, skip (no tokens to count)
3. **`execute()` return format** must be `{ content: [{ type: "text", text }] }`, not plain string. The `token_budget_status` tool must return this format.
4. **Cannot short-circuit LLM** via `before_prompt_build` — systemPrompt override is the only option, burns a small number of tokens. Acceptable trade-off.
5. **No standalone HTTP server** — use `api.registerHttpRoute()` to mount dashboard on Gateway's server. Routes use `auth: "gateway"` (inherits Gateway's auth). Security note: dashboard is as secure as the Gateway's network binding — if Gateway is exposed beyond localhost, the dashboard (including config POST endpoint) is also exposed.

### Config Hot-Reload

Config is re-read on every hook invocation (file is small, ~200 bytes, negligible perf impact). This ensures Dashboard changes take effect immediately without gateway restart.

### Usage Data Retention

Auto-prune entries older than 90 days on each write. Keeps file small, covers weekly/monthly reporting needs.

### Token Estimation Fallback

When `event.messages` lacks `.usage`, estimate with 1 char ≈ 1 token (conservative for Chinese-heavy content, where 1 Chinese character ≈ 2-3 tokens). This is a deliberate change from v1's `1 token ≈ 4 chars` ratio, which underestimates CJK token usage. Priority: always prefer real usage data from `.usage`.

## Architecture

### File Structure

```
index.js              — Plugin entry: registers hooks + HTTP routes
storage.js            — Config/usage file I/O, data helpers
prices.js             — Built-in model price table + cost calculation
dashboard.html        — Single-file frontend (HTML + CSS + JS)
openclaw.plugin.json  — Plugin manifest
package.json          — npm package config
test/
  prices.test.js      — Price table + cost calculation tests
  storage.test.js     — Storage layer tests (including v1 migration, pruning)
  hooks.test.js       — Integration tests for hook logic
```

### Plugin Registration Flow

```
register(api) →
  1. api.on("before_prompt_build") — re-read config, check limit, block if exceeded
  2. api.on("agent_end") — extract tokens from event.messages, write usage
  3. api.registerTool("token_budget_status") — agent self-query with cost info
       Returns: { content: [{ type: "text", text: "## Token Budget Status\n..." }] }
       Shows per-agent: tokens (input/output/total), limit, model, cost (USD + CNY)
  4. api.registerHttpRoute("/token-budget/*") — dashboard + API
```

### HTTP API Routes (mounted on Gateway)

All routes use `auth: "gateway"` and `match: "exact"`. Route conflicts with other plugins are unlikely given the `/token-budget/` prefix namespace.

| Route | Method | Purpose |
|-------|--------|---------|
| `/token-budget` | GET | Serve dashboard.html (read once at registration, cached in memory) |
| `/token-budget/api/status` | GET | Current day usage + limits + costs for all agents |
| `/token-budget/api/report` | GET | Usage & cost report (query: period=day/week/month) |
| `/token-budget/api/config` | GET | Read current config |
| `/token-budget/api/config` | POST | Update config (limits, models, etc.) |

### Dashboard Features

**Control Panel:**
- List all agents with their current model and daily token limit
- Edit limits per agent (save to config.json)
- Add/remove agent configurations

**Report Panel:**
- Daily view: per-agent token usage bar chart (input/output split) + cost in USD & CNY
- Weekly view: 7-day aggregation per agent
- Monthly view: 30-day aggregation per agent
- Summary row: total tokens, total cost across all agents

### Cost Calculation

```
cost_usd = (input_tokens / 1_000_000) * price.input
          + (output_tokens / 1_000_000) * price.output
cost_cny = cost_usd * exchangeRate
```

## Out of Scope (v2)

- Fee-based limits (only token limits — cost is reporting only, see `limits` note above)
- Multi-currency beyond USD/CNY
- Historical data export
- User authentication on dashboard (relies on Gateway's network binding)
- Auto-sync model config from OpenClaw agent settings (manual config for now)
