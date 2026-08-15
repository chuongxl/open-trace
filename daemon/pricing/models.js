// Reference rates (public API pricing) used as efficiency metric only.
// User is on subscription — these are NOT actual billing amounts.
// All UI values MUST be labeled "equiv. cost".

export const PRICING = {
  // Anthropic — per 1M tokens, USD
  'claude-opus-4':              { input: 15.00, output: 75.00, cache_read: 1.50,  cache_write: 18.75 },
  'claude-sonnet-4-5':          { input: 3.00,  output: 15.00, cache_read: 0.30,  cache_write: 3.75  },
  'claude-sonnet-4':            { input: 3.00,  output: 15.00, cache_read: 0.30,  cache_write: 3.75  },
  'claude-haiku-3-5':           { input: 0.80,  output: 4.00,  cache_read: 0.08,  cache_write: 1.00  },
  'claude-haiku-3':             { input: 0.25,  output: 1.25,  cache_read: 0.03,  cache_write: 0.30  },
  // OpenAI — per 1M tokens, USD
  'gpt-4o':                     { input: 5.00,  output: 15.00, cache_read: 2.50,  cache_write: 0     },
  'gpt-4o-mini':                { input: 0.15,  output: 0.60,  cache_read: 0.075, cache_write: 0     },
  'o3':                         { input: 10.00, output: 40.00, cache_read: 2.50,  cache_write: 0     },
  'o4-mini':                    { input: 1.10,  output: 4.40,  cache_read: 0.275, cache_write: 0     },
  // Fallback for unknown models
  'unknown':                    { input: 3.00,  output: 15.00, cache_read: 0.30,  cache_write: 3.75  },
};

/**
 * Estimate equivalent cost in USD using reference API rates.
 * @param {string} model  - Model identifier (e.g. 'claude-sonnet-4-5')
 * @param {{input_tokens, output_tokens, cache_read_tokens, cache_write_tokens}} usage
 * @returns {number} Equivalent USD cost (reference rate, NOT actual billing)
 */
export function estimateCost(model, usage = {}) {
  // Normalize model name: strip date suffixes, lowercase
  const key = Object.keys(PRICING).find(k =>
    model?.toLowerCase().startsWith(k)
  ) ?? 'unknown';
  const p = PRICING[key];
  const M = 1_000_000;
  return (
    ((usage.input_tokens        ?? 0) / M) * p.input        +
    ((usage.output_tokens       ?? 0) / M) * p.output       +
    ((usage.cache_read_tokens   ?? 0) / M) * p.cache_read   +
    ((usage.cache_write_tokens  ?? 0) / M) * p.cache_write
  );
}

/** Format an equivalent cost value for display */
export function formatCost(usd) {
  if (usd < 0.001) return '~$0.00';
  if (usd < 0.01)  return `~$${usd.toFixed(4)}`;
  if (usd < 1)     return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
