# Setup script (Phase 8)

**Source:** issue #14. **Status:** implemented.

`./setup.sh` is idempotent. Steps: check Node >= 22 → `npm install` (root + dashboard) and build dashboard → write a marked block (`# >>> open-trace >>>`) to `~/.zshrc` or `~/.bashrc`, replaced on re-run → render `deploy/open-trace.plist` (macOS, `launchctl bootstrap`) or `deploy/open-trace.service` (Linux, `systemctl --user enable --now`).

Decisions: the block exports `ANTHROPIC_BASE_URL` (proxy port) and `API_TIMEOUT_MS=600000` so long streamed turns do not time out. Node is detected with `command -v node` and baked in as an absolute path (launchd has no shell PATH), so re-run after switching Node versions. `--no-start` writes files without loading the service (used to test under a throwaway `HOME`). Issue text said Node 18 and `cd daemon && npm install`; the floor is 22 (#68) and deps live at the root.
