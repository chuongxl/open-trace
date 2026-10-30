# Local API security (#62)

`app.use(cors())` let any web page read the API, and nothing authenticated mutating calls. Must land before the control endpoints of phases 14–15 (#58, #59).

Guard (`daemon/security.js`) on `/api`: loopback-only `Host` on the listening port; browser `Origin` limited to the dashboard and `localhost:5173` (+ `OPEN_TRACE_ALLOWED_ORIGINS`), CORS granted only to those; bearer token (32 random bytes, `<db dir>/token`, 0600) on every non-GET/HEAD/OPTIONS request, compared in constant time. `GET /api/token` serves it to allowed origins; the dashboard client attaches it to mutating calls.

Out of scope: protecting against other local processes of the same user; authentication on the proxy ports; read endpoints requiring the token (reads are protected by Host/Origin only, since the dashboard is token-less for GET).

Tests: `tests/security.test.mjs` (foreign origin/host rejected, no CORS grant, 401 without token, 200 with, token file mode).
