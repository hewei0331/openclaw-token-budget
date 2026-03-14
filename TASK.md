# Task: OpenClaw Token Budget Plugin

Build an OpenClaw plugin that limits daily token usage per agent.

## Background
OpenClaw is a personal AI assistant framework. It has a plugin system with hooks.
The relevant hook is `before_prompt_build` which fires before each LLM request.

## Plugin Location
OpenClaw plugins live in `~/.openclaw/plugins/` as JS/TS files or folders.
Each plugin exports a default function that receives the OpenClaw plugin API.

## What to Build

A plugin at `~/.openclaw/plugins/token-budget/index.js` that:

1. **Tracks daily token usage per agent** in a JSON file at `~/.openclaw/token-budget/usage.json`
   - Format: `{ "2026-03-14": { "main": 12500, "stella": 3200 } }`
   - Resets automatically each day (just check date)

2. **Intercepts requests via `before_prompt_build` hook**
   - Read current agent's today usage
   - If usage >= limit for that agent → return a fake systemPrompt telling the agent to reply "今日 token 已达上限，明天再来吧 🌙" and nothing else
   - If under limit → let request through normally

3. **Counts tokens after each response** via `after_agent_turn` hook (or similar)
   - Add input + output tokens to that agent's daily count
   - Save to usage.json

4. **Config file** at `~/.openclaw/token-budget/config.json`
   - Format: `{ "limits": { "main": 50000, "stella": 10000, "default": 5000 } }`
   - `default` applies to agents not listed
   - If limit is 0 or missing for agent, no limit applied

5. **Status command** (optional but nice): expose a tool or log that shows current usage

## Technical Notes
- OpenClaw plugin API: look at how hooks are registered. The `before_prompt_build` hook
  should return `{ systemPrompt: string }` to override, or `undefined` to pass through
- Agent ID is available in the hook context
- Keep it simple: plain Node.js, no external dependencies, CommonJS or ESM both fine
- Token counting: use the token counts from the hook context if available, 
  otherwise estimate (1 token ≈ 4 chars)

## Deliverables
1. `~/.openclaw/plugins/token-budget/index.js` - the plugin
2. `~/.openclaw/token-budget/config.json` - default config
3. `README.md` in the plugin folder explaining setup and config

When done, run:
openclaw system event --text "token-budget plugin done" --mode now
