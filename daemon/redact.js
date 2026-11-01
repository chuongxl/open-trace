// Redaction (#64): secrets are removed from text before it is stored. Only the stored copy is
// changed; requests and responses are forwarded untouched. Patterns are linear (no nested quantifiers).
import { config } from './config.js';

const tag = (kind) => `[REDACTED:${kind}]`;
const keep = (s) => s.startsWith('[REDACTED');

// [kind, regex]. Specific token formats first, the generic key=value rule last.
const BUILTIN = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{16,}/g],
  ['api-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ['aws-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['google-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['stripe-key', /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
];

// Authorization: Bearer <token>
const BEARER = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{20,})/gi;
// api_key = "...", "password": "...", SECRET_TOKEN=..., also inside JSON-escaped text (\"key\":\"value\").
const KEY_VALUE = /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|passw(?:or)?d|credential)s?[A-Za-z0-9_]*)(\\?["']?\s*[:=]\s*\\?["']?)([^\s"',;}\]\\]{8,})/gi;

/** Build a redactor. Exported so tests (and callers) can use their own settings. */
export function createRedactor({ enabled = true, extraPatterns = [] } = {}) {
  const extra = [];
  for (const src of extraPatterns) {
    try { extra.push(['custom', new RegExp(src, 'g')]); }
    catch { console.warn(`[redact] ignoring invalid pattern: ${src}`); }
  }
  const rules = [...BUILTIN, ...extra];

  return function redact(text) {
    if (!enabled || typeof text !== 'string' || text === '') return text;
    let out = text;
    for (const [kind, re] of rules) out = out.replace(re, tag(kind));
    out = out.replace(BEARER, (_m, pre) => pre + tag('bearer'));
    out = out.replace(KEY_VALUE, (m, name, sep, value) => {
      // Numbers and booleans are counters and flags (input_tokens: 12345678), not secrets.
      if (keep(value) || /^\d+$/.test(value) || /^(true|false|null)$/i.test(value)) return m;
      return name + sep + tag('secret');
    });
    return out;
  };
}

export const redact = createRedactor(config.redaction);
