import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const BASE = 1750000000000;
const API = "http" + "://localhost:";
function createFixture(dir) {
  const ocPath = join(dir, "opencode.db");
  const db = new Database(ocPath);
  db.exec(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, path TEXT, title TEXT, version INTEGER, share_url TEXT, metadata TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, revert TEXT, permission TEXT, agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER, time_compacting INTEGER, time_archived INTEGER); " +
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); " +
    "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);"
  );
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "sess-1", "proj-1", "ws-1", null, "slug-1", "/tmp/demo-proj", null, "Demo Fix Session", 1, null, null, 0.012, 1200, 340, 60, 90, 20, null, null, "cli", "claude-haiku-4-5", BASE + 1000, BASE + 9000, null, null);
  const insMsg = db.prepare("INSERT INTO message VALUES (?,?,?,?,?)");
  const insPart = db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)");
  const msg = (id, ts, role) => insMsg.run(id, "sess-1", ts, ts, JSON.stringify({ role }));
  const part = (id, mid, ts, data) => insPart.run(id, mid, "sess-1", ts, ts, JSON.stringify(data));
  msg("m1", BASE + 1000, "user");
  part("p1", "m1", BASE + 1000, { type: "text", text: "Refactor the auth module" });
  msg("m2", BASE + 2000, "assistant");
  part("p2", "m2", BASE + 2000, { type: "tool-call", id: "tc1", name: "bash", input: { command: "ls" } });
  msg("m3", BASE + 4000, "tool");
  part("p3", "m3", BASE + 4000, { type: "tool-result", id: "tc1", name: "bash", result: { type: "text", value: "src ndoe_modules" } });
  msg("m4", BASE + 5000, "assistant");
  part("p4", "m4", BASE + 5000, { type: "text", text: "Done, refactored auth" });
  db.close();
  return ocPath;
}

function appendMessage(ocPath) {
  const db = new Database(ocPath);
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run("m5", "sess-1", BASE + 30000, BASE + 30000, JSON.stringify({ role: "user" }));
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run("p5", "m5", "sess-1", BASE + 30000, BASE + 30000, JSON.stringify({ type: "text", text: "Follow up: run tests" }));
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run("m6", "sess-1", BASE + 31000, BASE + 31000, JSON.stringify({ role: "assistant" }));
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run("p6", "m6", "sess-1", BASE + 31000, BASE + 31000, JSON.stringify({ type: "text", text: "Tests pass" }));
  db.close();
}

async function waitFor(fn, timeoutMs, stepMs) {
  const end = Date.now() + (timeoutMs || 15000);
  const step = stepMs || 250;
  let result = null;
  while (Date.now() < end) {
    result = await fn();
    if (result) return result;
    await new Promise(r => setTimeout(r, step));
  }
  return result;
}
test("opencode watcher syncs a fixture session end to end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ot-int-"));
  const ocPath = createFixture(dir);
  const otPath = join(dir, "data.db");
  const child = spawn(process.execPath, ["daemon/index.js"], {
    cwd: REPO,
    env: { ...process.env, OPENCODE_DB_PATH: ocPath, DB_PATH: otPath, DAEMON_PORT: "0", CLAUDE_PROXY_PORT: "0", COPILOT_PROXY_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", d => { out += d.toString(); });
  child.stderr.on("data", d => { out += d.toString(); });
  try {
    const port = await waitFor(() => {
      const m = out.match(/localhost:([0-9]+)/);
      return m ? m[1] : null;
    });
    assert.ok(port, "daemon failed to report a port: " + out);
    await waitFor(async () => {
      try { return (await fetch(API + port + "/api/health")).ok; }
      catch { return false; }
    });
    const sessions = await waitFor(async () => {
      const r = await fetch(API + port + "/api/sessions?tool=opencode");
      const j = await r.json();
      return j.length >= 1 ? j : null;
    });
    assert.ok(sessions, "watcher never synced the fixture; daemon log: " + out);
    assert.equal(sessions.length, 1);
    const s = sessions[0];
    assert.equal(s.tool, "opencode");
    assert.equal(s.project_name, "Demo Fix Session");
    assert.equal(s.model, "claude-haiku-4-5");
    assert.equal(s.total_input_tokens, 1200);
    assert.equal(s.total_output_tokens, 400);
    assert.equal(s.total_cache_read, 90);
    assert.equal(s.total_cache_write, 20);
    assert.ok(Math.abs(s.equiv_cost_usd - 0.012) < 1e-9);
    const det = await waitFor(async () => {
      const r = await fetch(API + port + "/api/sessions/" + s.id);
      const j = await r.json();
      return j.prompts.length === 2 ? j : null;
    });
    assert.ok(det, "expected 2 prompts (assistant messages) synced");
    const p1 = det.prompts[0];
    assert.equal(p1.input_text, "Refactor the auth module");
    const pc = await (await fetch(API + port + "/api/prompts/" + p1.id)).json();
    assert.equal(pc.tool_calls.length, 2, "tool-call + tool-result should pair");
    const call = pc.tool_calls[0];
    const result = pc.tool_calls[1];
    assert.equal(call.call_type, "tool-call");
    assert.equal(call.name, "bash");
    assert.equal(result.call_type, "tool-result");
    assert.ok(String(result.output).includes("src"));
    appendMessage(ocPath);
    const det2 = await waitFor(async () => {
      const r = await fetch(API + port + "/api/sessions/" + s.id);
      const j = await r.json();
      return j.prompts.length === 3 ? j : null;
    });
    assert.ok(det2, "new prompt from follow-up message not synced; log: " + out);
    const s2 = (await (await fetch(API + port + "/api/sessions?tool=opencode")).json())[0];
    assert.equal(s2.total_input_tokens, 1200, "totals must not double on re-sync (replace mode)");
    assert.equal(s2.total_output_tokens, 400, "totals must not double on re-sync (replace mode)");
  } finally {
    child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});