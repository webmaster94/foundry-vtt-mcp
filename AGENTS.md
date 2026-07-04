# AGENTS.md — Foundry VTT MCP Bridge (fork)

Guidance for AI coding agents (and humans) working in this repository.

## What this is

A two-component bridge between Foundry VTT and MCP clients:

- **`packages/mcp-server`** — Node MCP server. `index.ts` is a thin stdio wrapper that talks JSON-lines over TCP (`127.0.0.1:31414`) to a singleton **backend** process (`backend.ts`) which owns all tools and Foundry connections. Killing the backend is safe: the wrapper respawns it on the next tool call.
- **`packages/foundry-module`** — the Foundry VTT module (id `foundry-mcp-bridge`, never rename). Registers query handlers on `CONFIG.queries` under the `foundry-mcp-bridge.` prefix and connects OUT to the MCP server (WebSocket, or WebRTC for remote instances; signaling on `port + 1`).
- **`shared`** — zod schemas used by both sides.

Request path: MCP client → stdio wrapper → backend (tool dispatch) → `FoundryClient.query('foundry-mcp-bridge.<handler>')` → module handler in the GM's browser → Foundry API.

## Build, test, verify

```bash
npm run build            # all workspaces; tsc is strict (exactOptionalPropertyTypes)
npm test                 # vitest unit tests (mcp-server workspace)
npm run smoke            # LIVE 16-step integration suite over the control channel.
                         # Requires the backend running AND a world connected.
                         # RUN THIS BEFORE EVERY RELEASE — unit tests use mocks
                         # and cannot catch Foundry-API misuse (see Gotchas).
```

Local deploy of the module (no packaging needed):

```powershell
# copy module.json + dist/lang/styles/templates/scripts to
# %LOCALAPPDATA%\FoundryVTT_Next\Data\modules\foundry-mcp-bridge  (path varies per install)
```

then reload the Foundry world. `execute-foundry-script` with `window.location.reload()` can do the reload remotely if a connection is already up.

## How to add a new capability (end to end)

1. **Module handler** — implement in an appropriate service (`document-service.ts`, `actor-builder.ts`, `compendium-search.ts`, ...) and register in `queries.ts` (`registerHandlers()` + a `handleX` method with the `assertGM()` guard). Record writes via `audit-service.ts`, including an `inverse` operation if undoable.
2. **Shared schema** — add request schema to `shared/src/schemas.ts` if the payload is non-trivial.
3. **Server tool** — add the tool definition + dispatch in the matching `packages/mcp-server/src/tools/*.ts` class; wire new tool classes into `backend.ts` (`allTools` + `additionalToolHandlers`).
4. **Tests** — unit test the tool class (see `tools/*.test.ts` for the mocking pattern) and add a step to `scripts/bridge-smoke-test.mjs`.
5. Version-bump both `package.json`s + `packages/foundry-module/module.json` together — the capability handshake surfaces mismatches to users as `VERSION_MISMATCH`.

## Conventions

- Prettier is enforced by a husky pre-commit hook (repo-wide sweep exists upstream; do not fight the formatter).
- Tool responses are JSON objects; the backend stringifies them into MCP text content. Throwing an `Error` produces `isError: true`; throw `BridgeError` (foundry-client.ts) to attach a machine-readable `errorCode`.
- All write paths must: check permissions (`permissionManager` / `assertGM`), audit (`auditService.record`), and where feasible support `dryRun` and record an `inverse`.
- Multi-server: tools never hold a `FoundryClient` for a specific profile — they get the `RoutingFoundryClient` facade. Per-call `server` args are handled centrally in `backend.ts` via `runWithServer` (AsyncLocalStorage); do not add per-tool routing.
- Keep tool output bounded: projection (`fields`), `maxBytes` caps, and limits. Unbounded dumps of compendium entries or schemas are regressions.

## Gotchas learned the hard way

- `game.world` is NOT a Document client-side — `getFlag`/`setFlag` don't exist on it. World-level storage = hidden world-scoped settings (see audit-service).
- Foundry's server caches module **metadata** from world launch: after deploying new module files, a browser reload runs the new code but `game.modules.get(...).version` may report the old version until the world is relaunched from setup.
- The WebRTC signaling port is `port + 1` on BOTH sides (module `webrtc-connection.ts`, server `foundry-connector.ts`). Keep them in sync.
- Only one Foundry connection per connector: two worlds pointed at the same profile port will fight. Distinct ports per profile; duplicate ports are rejected at registry load.
- The module retries connection forever (30s cadence after fast retries): backend restarts self-heal in ≤30s. A stuck connection usually means the world tab needs a refresh or the ports mismatch.
- The backend is a PERSISTENT DAEMON: wrappers spawn it orphaned (via `cmd start /b` on Windows) and never kill it, so the module's connection survives AI-client session ends and idle periods. It restarts itself when a wrapper detects a newer build on disk (entry-file signature in the control-channel ping), or via `npm run stop`. Queries during the first 90s of a listener's life wait up to 45s for the module to reconnect instead of failing (startup grace).
- The module only exists while a (GM) browser tab has the world open — `users: 0` on Foundry's `/api/status` means nothing can reconnect, no matter how patient the server is.
- Events flow module → server as `bridge-event` socket messages (event-service.ts hooks → SocketBridge.sendEvent → connector.onBridgeEvent → registry ring buffer, 200 entries, one seq counter). `wait-for-event` long-polls that buffer — it never talks to Foundry directly.
- Auth is a shared secret checked at the transport edge (WS upgrade query param + webrtc-offer body, foundry-connector.ts) against the profile's `authToken`. Empty token = open (loopback default). The module sends it from the `authToken` world setting.
- CONTEXT BUDGET is a feature: tool definitions are the per-session tax every MCP client pays (~4 chars ≈ 1 token). The smoke test fails if the catalog exceeds 70KB. When adding tools: terse descriptions, no prose examples in schemas, share property constants, and prefer extending an existing tool over adding a new one. The per-type CRUD wrappers are deliberately dispatch-only (see document-management.ts workflowToolDefinitions) — do not re-advertise them.
- `tsc` here uses `exactOptionalPropertyTypes` — `{ foo: maybeUndefined }` into an optional property fails; guard or assert first.
- Vitest mocks of `FoundryClient` must include every method a code path touches (`getCapabilities` bit us once).

## Release process

1. `npm run build && npm test && npm run smoke` (smoke against a live world).
2. Bump versions (root, both packages, shared, `module.json`) — keep them identical.
3. Commit, push, then publish a GitHub release tagged `vX.Y.Z` (target branch can be the feature branch). CI (`.github/workflows/module-release.yml`, League-of-Foundry-Developers pattern) builds and attaches `module.json` + `module.zip`; the stable install URL is `releases/latest/download/module.json`.
4. Users update the module in Foundry and reload their world; the MCP server side is picked up by restarting the backend process (or the MCP client connection).

## Repo layout quick reference

```
packages/foundry-module/src/
  main.ts               module lifecycle, hooks, reconnect
  queries.ts            ALL CONFIG.queries handler registration
  document-service.ts   generic CRUD + dryRun/diff + batch + undo
  actor-builder.ts      build-actor-from-spec
  compendium-search.ts  system-data content search
  audit-service.ts      audit log + inverse ops (world settings storage)
  script-executor.ts    execute-foundry-script
  socket-bridge.ts      connection to MCP server (+ indefinite retry)
packages/mcp-server/src/
  index.ts              stdio wrapper (thin; rarely touch)
  backend.ts            singleton backend: tool registry + dispatch + control channel
  server-registry.ts    named profiles, routing facade, per-call overrides
  foundry-client.ts     query transport + BridgeError codes + capabilities cache
  foundry-connector.ts  WebSocket/WebRTC listeners
  tools/*.ts            one class per tool family
scripts/bridge-smoke-test.mjs   live integration suite (npm run smoke)
scripts/install.mjs             client setup: npm run setup — builds and registers
                                the server with Claude Desktop / Claude Code / Codex
```
