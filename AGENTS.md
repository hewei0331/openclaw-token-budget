# AGENTS.md — openclaw-token-budget

## Project

OpenClaw plugin that enforces per-agent daily token budgets.
npm package: `@hewei0331/openclaw-token-budget`

## Architecture

- **index.js** — plugin entry point, registers hooks and tool
- **openclaw.plugin.json** — OpenClaw plugin manifest
- **package.json** — npm package config

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Plugin logic: before_prompt_build + llm_output hooks |
| `openclaw.plugin.json` | OpenClaw manifest (required for discovery) |
| `~/.openclaw/token-budget/config.json` | Per-agent limits config |
| `~/.openclaw/token-budget/usage.json` | Daily usage tracking (runtime) |

## Known Issues / Open Questions

1. **Hook names unverified** — `before_prompt_build` and `llm_output` are assumed correct but not yet tested against a live OpenClaw instance. Need to confirm via local install + gateway logs.
2. **agentId availability** — `ctx.agentId` may not be available in all hook contexts; need to verify what's in the context object.
3. **Token counting fallback** — if `event.usage` is absent, falls back to `chars / 4` estimate; accuracy TBD.

## Development Workflow

```bash
# 1. Edit index.js
# 2. Local test
openclaw plugins install file:///Users/weihe/Documents/Projects/openclaw-token-budget
openclaw gateway restart
openclaw logs | grep token-budget

# 3. Verify hooks fire (check gateway logs)
# 4. Bump version
npm version patch

# 5. Publish
npm publish --access public
```

## Testing Checklist

- [ ] Plugin loads (`[token-budget] Plugin loaded` in gateway logs)
- [ ] `before_prompt_build` fires on each turn (log shows usage check)
- [ ] `llm_output` fires and increments usage.json
- [ ] Over-limit returns block message without LLM call
- [ ] `token_budget_status` tool returns correct data
- [ ] Limit resets at midnight

## GitHub

Repo: https://github.com/hewei0331/openclaw-token-budget (to be created)
