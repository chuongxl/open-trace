# dashboard

open-trace SPA (Vite + React + Tailwind v4). Proxies `/api/*` to the daemon on port 9900 (see repo
root `CLAUDE.md`) — start the daemon first with `npm run dev` from the repo root.

- `npm run dev` — dev server (default port 5173), daemon must be running for API calls to work
- `npm run build` — production build
- `node scripts/check-client-exports.mjs` — verify the API client exports
