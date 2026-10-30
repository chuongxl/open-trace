#!/usr/bin/env bash
# One-shot install: deps, dashboard build, shell env, auto-start service. Safe to re-run.
# --no-start writes everything but does not (re)load the service.
set -euo pipefail

START=1
[ "${1:-}" = "--no-start" ] && START=0

ROOT="$(cd "$(dirname "$0")" && pwd)"
PROXY_PORT="${CLAUDE_PROXY_PORT:-9876}"
DASH_PORT="${DAEMON_PORT:-9900}"

if [ -t 1 ]; then G=$'\e[32m'; R=$'\e[31m'; B=$'\e[1m'; N=$'\e[0m'; else G=; R=; B=; N=; fi
step() { echo "${B}==>${N} $*"; }
ok()   { echo "${G}✓${N} $*"; }
die()  { echo "${R}✗ $*${N}" >&2; exit 1; }

# 1. Node
NODE_PATH="$(command -v node)" || die "Node.js not found. Install Node >= 22."
[ "$("$NODE_PATH" -p 'process.versions.node.split(".")[0]')" -ge 22 ] || die "Node >= 22 required (found $("$NODE_PATH" -v))."
ok "node $("$NODE_PATH" -v) at $NODE_PATH"

# 2. Dependencies + dashboard build
step "Installing dependencies"
(cd "$ROOT" && npm install --no-audit --no-fund)
(cd "$ROOT/dashboard" && npm install --no-audit --no-fund && npm run build)
ok "dashboard built"

# 3. Shell profile (idempotent: a marked block, replaced on re-run)
case "$(basename "${SHELL:-}")" in zsh) RC="$HOME/.zshrc" ;; *) RC="$HOME/.bashrc" ;; esac
BEGIN="# >>> open-trace >>>"; END="# <<< open-trace <<<"
touch "$RC"
sed -i.bak "/^$BEGIN\$/,/^$END\$/d" "$RC" && rm -f "$RC.bak"
cat >> "$RC" <<BLOCK
$BEGIN
export ANTHROPIC_BASE_URL=http://localhost:$PROXY_PORT
export API_TIMEOUT_MS=600000
$END
BLOCK
ok "env block written to $RC"

# 4. Auto-start service
mkdir -p "$HOME/.open-trace"
render() { sed "s|{{NODE_PATH}}|$NODE_PATH|g; s|{{PWD}}|$ROOT|g; s|{{HOME}}|$HOME|g" "$1"; }

case "$(uname -s)" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/dev.open-trace.plist"
    mkdir -p "$(dirname "$PLIST")"
    render "$ROOT/deploy/open-trace.plist" > "$PLIST"
    if [ "$START" = 1 ]; then
      launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$PLIST"
    fi
    ok "launchd agent: $PLIST"
    ;;
  Linux)
    UNIT="$HOME/.config/systemd/user/open-trace.service"
    mkdir -p "$(dirname "$UNIT")"
    render "$ROOT/deploy/open-trace.service" > "$UNIT"
    if [ "$START" = 1 ]; then
      systemctl --user daemon-reload
      systemctl --user enable --now open-trace.service
      systemctl --user restart open-trace.service
    fi
    ok "systemd user unit: $UNIT"
    ;;
  *) die "Unsupported OS $(uname -s); run 'npm start' manually." ;;
esac

echo
ok "${B}open-trace is set up.${N} Open a new terminal, then visit http://localhost:$DASH_PORT"
