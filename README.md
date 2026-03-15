# openclaw-token-budget

Per-agent daily token budget plugin for [OpenClaw](https://openclaw.ai) with cost tracking and web dashboard.

Enforces per-agent daily token limits. When an agent hits its limit, it replies with a friendly message instead of making a full LLM call. Tracks costs by model with USD/CNY display.

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
    "kids-tutor": 20000,
    "default": 5000
  },
  "models": {
    "main": "claude-sonnet-4-20250514",
    "stella": "gpt-4o",
    "kids-tutor": "claude-haiku-4-5-20251001",
    "default": "gpt-4o-mini"
  },
  "priceOverrides": {},
  "exchangeRate": 7.2
}
```

### Config fields

| Field | Description |
|-------|-------------|
| `limits` | Per-agent daily token ceiling (input + output). `default` applies to unlisted agents. Set `0` to disable. |
| `models` | Per-agent model ID for cost calculation. Must match the model configured in OpenClaw. |
| `priceOverrides` | Override built-in model prices. Format: `{ "model-id": { "input": N, "output": N } }` (USD per 1M tokens). |
| `exchangeRate` | USD to CNY conversion rate. Default: `7.2`. |

### Built-in model prices (USD per 1M tokens)

| Model | Input | Output |
|-------|-------|--------|
| claude-sonnet-4-20250514 | $3.00 | $15.00 |
| claude-haiku-4-5-20251001 | $0.80 | $4.00 |
| claude-opus-4-20250514 | $15.00 | $75.00 |
| gpt-4o | $2.50 | $10.00 |
| gpt-4o-mini | $0.15 | $0.60 |
| gemini-2.0-flash | $0.10 | $0.40 |
| gemini-2.5-pro | $1.25 | $10.00 |
| deepseek-chat | $0.27 | $1.10 |
| deepseek-reasoner | $0.55 | $2.19 |

## Dashboard

After installing, open in your browser:

```
http://localhost:<gateway-port>/token-budget
```

Two panels:
- **Control Panel** — view and edit per-agent limits and model assignments
- **Reports** — daily/weekly/monthly token usage and cost breakdown (USD + CNY)

## How it works

1. **`before_prompt_build` hook** — checks today's usage before each LLM call. If over limit, overrides the system prompt with a block message (no full LLM processing).
2. **`agent_end` hook** — after each turn, extracts `input_tokens` and `output_tokens` from the assistant message and writes to `usage.json`.
3. **`token_budget_status` tool** — agents can query their own usage and limits.
4. **HTTP API** — dashboard reads/writes config and usage via REST endpoints mounted on the Gateway.

## Cost calculation

```
cost_usd = (input_tokens / 1M) * model_input_price + (output_tokens / 1M) * model_output_price
cost_cny = cost_usd * exchangeRate
```

## Usage data

Stored at `~/.openclaw/token-budget/usage.json`. Input and output tokens are tracked separately per agent per day. Data older than 90 days is automatically pruned.

```json
{
  "2026-03-15": {
    "main": { "input": 8000, "output": 4500 },
    "stella": { "input": 2000, "output": 1200 }
  }
}
```

## Migration from v1

Automatic. If `usage.json` contains v1 format (flat token numbers), it is converted on first read. All legacy tokens are attributed to output for conservative cost estimation.

## Development

```bash
# Local install for testing
openclaw plugins install file:///path/to/openclaw-token-budget

# Run tests
npm test

# Publish
npm publish --access public
```

## License

MIT
