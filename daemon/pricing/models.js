// Reference rates (public API pricing) used as efficiency metric only.
// User is on subscription — these are NOT actual billing amounts.
// All UI values MUST be labeled "equiv. cost".
// Rates checked against platform.claude.com/docs/en/about-claude/pricing on 2026-11-01.
// cache_write is the 5-minute rate (Claude Code's default). Keys are matched by prefix, so a more
// specific key (claude-opus-5-5) MUST come before a shorter one (claude-opus-5).
//
// NOTE on rate limits (Aug 2026): every model is rate-limited — there is no
// "unlimited" model. API rate limits scale with account Tier + model class:
//   Haiku  <  Sonnet  <  Opus/Fable   (Haiku has the highest RPM/TPM by far)
// On Claude subscription (Claude Code Pro/Max), message limits are weighted:
// Haiku-tier messages count ~1 unit, Sonnet ~several, Opus/Fable the most.
// → For dev-loop testing, Haiku 4.5 is the cheapest AND least-limit-heavy model.

export const PRICING = {
  // Anthropic — per 1M tokens, USD
  'claude-fable-5-1':           { input: 10.00, output: 50.00, cache_read: 0.25,  cache_write: 12.50 },
  'claude-fable-5':             { input: 10.00, output: 50.00, cache_read: 1.00,  cache_write: 12.50 },
  'claude-opus-5-5':            { input: 4.00,  output: 20.00, cache_read: 0.20,  cache_write: 5.00  },
  'claude-opus-5':              { input: 5.00,  output: 25.00, cache_read: 0.50,  cache_write: 6.25  },
  'claude-opus-4-8':            { input: 5.00,  output: 25.00, cache_read: 0.50,  cache_write: 6.25  },
  'claude-opus-4-7':            { input: 5.00,  output: 25.00, cache_read: 0.50,  cache_write: 6.25  },
  'claude-opus-4-6':            { input: 5.00,  output: 25.00, cache_read: 0.50,  cache_write: 6.25  },
  'claude-opus-4-5':            { input: 5.00,  output: 25.00, cache_read: 0.50,  cache_write: 6.25  },
  'claude-opus-4':              { input: 15.00, output: 75.00, cache_read: 1.50,  cache_write: 18.75 },
  'claude-sonnet-5-5':          { input: 2.00,  output: 10.00, cache_read: 0.10,  cache_write: 2.50  },
  'claude-sonnet-5':            { input: 2.00,  output: 10.00, cache_read: 0.20,  cache_write: 2.50  },
  'claude-sonnet-4-6':          { input: 3.00,  output: 15.00, cache_read: 0.30,  cache_write: 3.75  },
  'claude-sonnet-4-5':          { input: 3.00,  output: 15.00, cache_read: 0.30,  cache_write: 3.75  },
  'claude-sonnet-4':            { input: 3.00,  output: 15.00, cache_read: 0.30,  cache_write: 3.75  },
  // Haiku 5.5 is priced per request by prompt length (input + cache read + cache write tokens):
  // over 100k tokens the whole request pays the `long` rates.
  'claude-haiku-5-5':           { input: 0.10,  output: 0.50,  cache_read: 0.01,  cache_write: 0.125,
                                  long: { above: 100_000, input: 0.50, output: 2.50, cache_read: 0.05, cache_write: 0.625 } },
  'claude-haiku-4-5':           { input: 1.00,  output: 5.00,  cache_read: 0.10,  cache_write: 1.25  },
  'claude-haiku-3-5':           { input: 0.80,  output: 4.00,  cache_read: 0.08,  cache_write: 1.00  },
  'claude-haiku-3':             { input: 0.25,  output: 1.25,  cache_read: 0.03,  cache_write: 0.30  },
  // OpenAI — per 1M tokens, USD
  'gpt-4o-mini':                { input: 0.15,  output: 0.60,  cache_read: 0.075, cache_write: 0     },
  'gpt-4o':                     { input: 5.00,  output: 15.00, cache_read: 2.50,  cache_write: 0     },
  'o3':                         { input: 10.00, output: 40.00, cache_read: 2.50,  cache_write: 0     },
  'o4-mini':                    { input: 1.10,  output: 4.40,  cache_read: 0.275, cache_write: 0     },
  // Fallback for unknown models
  'unknown':                    { input: 3.00,  output: 15.00, cache_read: 0.30,  cache_write: 3.75  },
};

const warned = new Set();
function warnUnpriced(model) {
  if (warned.has(model)) return;
  warned.add(model);
  console.warn(`[pricing] no rates for model "${model}"; equiv. cost uses fallback rates. Add it to daemon/pricing/models.js.`);
}

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
  );
  if (!key) warnUnpriced(model);
  let p = PRICING[key ?? 'unknown'];
  const prompt = (usage.input_tokens ?? 0) + (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
  if (p.long && prompt > p.long.above) p = p.long;
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
