export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id                  TEXT PRIMARY KEY,
    tool                TEXT NOT NULL,
    started_at          INTEGER NOT NULL,
    ended_at            INTEGER,
    project_path        TEXT,
    project_name        TEXT,
    model               TEXT,
    total_input_tokens  INTEGER DEFAULT 0,
    total_output_tokens INTEGER DEFAULT 0,
    total_cache_read    INTEGER DEFAULT 0,
    total_cache_write   INTEGER DEFAULT 0,
    equiv_cost_usd      REAL    DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS prompts (
    id                 TEXT PRIMARY KEY,
    session_id         TEXT NOT NULL REFERENCES sessions(id),
    timestamp          INTEGER NOT NULL,
    model              TEXT,
    input_text         TEXT,
    input_tokens       INTEGER DEFAULT 0,
    output_tokens      INTEGER DEFAULT 0,
    cache_read_tokens  INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    equiv_cost_usd     REAL DEFAULT 0,
    raw_request        TEXT,
    raw_response       TEXT
  );

  CREATE TABLE IF NOT EXISTS tool_calls (
    id          TEXT PRIMARY KEY,
    prompt_id   TEXT NOT NULL REFERENCES prompts(id),
    call_order  INTEGER NOT NULL,
    call_type   TEXT NOT NULL,
    name        TEXT NOT NULL,
    input       TEXT,
    output      TEXT,
    duration_ms INTEGER,
    timestamp   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS optimizations (
    id                TEXT PRIMARY KEY,
    prompt_id         TEXT NOT NULL REFERENCES prompts(id),
    original_prompt   TEXT,
    optimized_prompt  TEXT,
    improvement_notes TEXT,
    token_delta       INTEGER,
    webllm_model      TEXT,
    created_at        INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_prompts_session   ON prompts(session_id);
  CREATE INDEX IF NOT EXISTS idx_prompts_ts        ON prompts(timestamp);
  CREATE INDEX IF NOT EXISTS idx_tool_calls_prompt ON tool_calls(prompt_id, call_order);
  CREATE INDEX IF NOT EXISTS idx_sessions_tool     ON sessions(tool);
  CREATE INDEX IF NOT EXISTS idx_sessions_path     ON sessions(project_path);
  CREATE INDEX IF NOT EXISTS idx_sessions_ts       ON sessions(started_at);
`;
