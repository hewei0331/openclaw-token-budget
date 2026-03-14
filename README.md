# openclaw-token-budget

Per-agent daily token budget plugin for [OpenClaw](https://openclaw.ai).

Prevents runaway token usage by enforcing per-agent daily limits. When an agent hits its limit, it replies with a friendly message instead of making an LLM call.

## Install

```bash
openclaw plugins install @hewei0331/openclaw-token-budget
```

## Config

Edit `~/.openclaw/token-budget/config.json`:

```json
{
  "limits": {
    "main": 50000,
    "stella": 10000,
    "default": 5000
  }
}
```

- Keys are agent IDs
- `default` applies to any agent not listed
- Set to `0` to disable limiting for that agent
- Limits reset at midnight (local time)

## How it works

- `before_prompt_build` hook: checks today's usage before each LLM call; if over limit, returns a block message without calling the model
- `llm_output` hook: counts input + output tokens after each response and accumulates in `~/.openclaw/token-budget/usage.json`
- `token_budget_status` tool: agents can query their current usage and limits

## Usage data

Stored at `~/.openclaw/token-budget/usage.json`:

```json
{
  "2026-03-14": {
    "main": 12500,
    "stella": 3200
  }
}
```

## Development

```bash
# Local install for testing
openclaw plugins install file:///Users/weihe/Documents/Projects/openclaw-token-budget

# Publish
npm publish --access public
```

## License

MIT
