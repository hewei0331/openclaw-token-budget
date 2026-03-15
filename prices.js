// prices.js — Built-in model prices (USD per 1M tokens)
const PRICES = {
  "claude-sonnet-4-20250514":    { input: 3,    output: 15 },
  "claude-haiku-4-5-20251001":   { input: 0.8,  output: 4 },
  "claude-opus-4-20250514":      { input: 15,   output: 75 },
  "gpt-4o":                      { input: 2.5,  output: 10 },
  "gpt-4o-mini":                 { input: 0.15, output: 0.6 },
  "gemini-2.0-flash":            { input: 0.10, output: 0.40 },
  "gemini-2.5-pro":              { input: 1.25, output: 10 },
  "deepseek-chat":               { input: 0.27, output: 1.10 },
  "deepseek-reasoner":           { input: 0.55, output: 2.19 },
};

function getPrice(modelId, priceOverrides) {
  if (priceOverrides && priceOverrides[modelId]) {
    return priceOverrides[modelId];
  }
  return PRICES[modelId] || null;
}

function calculateCost(inputTokens, outputTokens, modelId, priceOverrides) {
  const price = getPrice(modelId, priceOverrides);
  if (!price) return null;
  return (inputTokens / 1_000_000) * price.input
       + (outputTokens / 1_000_000) * price.output;
}

function allModelIds() {
  return Object.keys(PRICES);
}

module.exports = { PRICES, getPrice, calculateCost, allModelIds };
