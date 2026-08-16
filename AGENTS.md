# AGENTS.md — Foundry VTT MCP Bridge (fork)

Guidance for AI coding agents (and humans) working in this repository.

## What this is

A bridge between Foundry VTT and MCP clients, with an optional desktop controller:

- **`packages/mcp-server`** — Node MCP server. `index.ts` is a thin stdio wrapper that talks JSON-lines over TCP (`127.0.0.1:31414`) to a singleton **backend** process (`backend.ts`) which owns all tools and Foundry connections. Killing the backend is safe: the wrapper respawns it on the next tool call.
- **`packages/foundry-module`** — the Foundry VTT module (id `foundry-mcp-bridge`, never rename). Registers query handlers on `CONFIG.queries` under the `foundry-mcp-bridge.` prefix and connects OUT to the MCP server (WebSocket, or WebRTC for remote instances; signaling on `port + 1`).
- **`packages/desktop`** — secure Electron control panel and notification-area host. It supervises and talks to the same singleton backend; it is not a second MCP endpoint or connection owner. Renderer code has no Node access and reaches only narrow, validated main-process IPC methods.
- **`shared`** — zod schemas used by both sides.

Request path: MCP client → stdio wrapper → backend (tool dispatch) → `FoundryClient.query('foundry-mcp-bridge.<handler>')` → module handler in the GM's browser → Foundry API.

## Build, test, verify

```bash
npm run build            # all workspaces; tsc is strict (exactOptionalPropertyTypes)
npm test                 # vitest unit tests (server + module + desktop workspaces)
npm run pack:desktop:win # bundle backend + produce Electron win-unpacked payload
npm run test:fork-contract # baseline tools/handlers retained except approved removals
npm run smoke            # LIVE 27-step integration suite over the control channel.
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
5. Version-bump root, server, module, desktop, shared, and `packages/foundry-module/module.json` together — the capability handshake surfaces mismatches to users as `VERSION_MISMATCH`.

## Conventions

- Prettier is enforced by a husky pre-commit hook (repo-wide sweep exists upstream; do not fight the formatter).
- Tool responses are JSON objects; the backend stringifies them into MCP text content. Throwing an `Error` produces `isError: true`; throw `BridgeError` (foundry-client.ts) to attach a machine-readable `errorCode`.
- All write paths must: check permissions (`permissionManager` / `assertGM`), audit (`auditService.record`), and where feasible support `dryRun` and record an `inverse`.
- Multi-server: tools never hold a `FoundryClient` for a specific profile — they get the `RoutingFoundryClient` facade. Per-call `server` args are handled centrally in `backend.ts` via `runWithServer` (AsyncLocalStorage); do not add per-tool routing.
- Keep tool output bounded: projection (`fields`), `maxBytes` caps, and limits. Unbounded dumps of compendium entries or schemas are regressions.
- Desktop configuration saves must validate the entire profile set, write atomically, preserve a backup, apply with the registry's transactional reload, and restore/reload the prior file if application fails. Never send an existing `authToken` to the renderer; expose only whether it is set and use explicit keep/replace/clear semantics in Electron main.

## Gotchas learned the hard way

- `game.world` is NOT a Document client-side — `getFlag`/`setFlag` don't exist on it. World-level storage = hidden world-scoped settings (see audit-service).
- Foundry's server caches module **metadata** from world launch: after deploying new module files, a browser reload runs the new code but `game.modules.get(...).version` may report the old version until the world is relaunched from setup.
- The WebRTC signaling port is `port + 1` on BOTH sides (module `webrtc-connection.ts`, server `foundry-connector.ts`). Keep them in sync.
- Only one Foundry connection per connector: two worlds pointed at the same profile port will fight. Distinct ports per profile; duplicate ports are rejected at registry load.
- The module retries forever (30s cadence after fast retries), and browser online/pageshow/visibility events wake a delayed retry immediately. Backend restarts, duplicate-tab ownership changes, and transient ICE loss self-heal without a refresh. A persistent failure usually means ports, auth tokens, Local Network Access permission, or the GM client are wrong.
- The backend is a PERSISTENT DAEMON: wrappers spawn it orphaned (via `cmd start /b` on Windows) and never kill it, so the module's connection survives AI-client session ends and idle periods. It restarts itself when a wrapper detects a newer build on disk (entry-file signature in the control-channel ping), or via `npm run stop`. Queries during the first 90s of a listener's life wait up to 45s for the module to reconnect instead of failing (startup grace).
- The desktop app and stdio wrappers share the loopback control channel at `127.0.0.1:31414`. Status polling must be nonblocking and secret-free; it may read cached capabilities but must never issue a 45-second Foundry query on each UI refresh. The installed canonical profile path is `%APPDATA%\FoundryVTT MCP Bridge\foundry-servers.json` unless `FOUNDRY_SERVERS_CONFIG` explicitly overrides it.
- The module only exists while a GM browser/desktop client has the world open — `users: 0` on Foundry's `/api/status` means nothing can reconnect, no matter how patient the server is. A normal inactive tab works; a browser-frozen/discarded tab cannot run queries until resume.
- Node owns authoritative liveness: WebSocket protocol pings tolerate paused background JavaScript; WebRTC uses ICE/data-channel state plus a suspension-tolerant application heartbeat. Never add a competing browser reconnect owner.
- A write whose response times out or is lost after transport send is `UNKNOWN_OUTCOME`. It may already have committed; inspect current state before retrying.
- WebRTC framing is ordered, UTF-8 byte-aware, backpressured, and bounded to 16 MB per reassembled message. Keep browser and Node framing changes symmetric.
- Events flow module → server as `bridge-event` socket messages (event-service.ts hooks → SocketBridge.sendEvent → connector.onBridgeEvent → registry ring buffer, 200 entries, one seq counter). `wait-for-event` long-polls that buffer — it never talks to Foundry directly.
- Auth is a shared secret checked at the transport edge (WS upgrade query param + webrtc-offer body, foundry-connector.ts) against the profile's `authToken`. Empty token = open (loopback default). The module sends it from the `authToken` world setting.
- CONTEXT BUDGET is a feature: tool definitions are the per-session tax every MCP client pays (~4 chars ≈ 1 token). The smoke test fails if the catalog exceeds 70KB. When adding tools: terse descriptions, no prose examples in schemas, share property constants, and prefer extending an existing tool over adding a new one. The per-type CRUD wrappers are deliberately dispatch-only (see document-management.ts workflowToolDefinitions) — do not re-advertise them.
- `tsc` here uses `exactOptionalPropertyTypes` — `{ foo: maybeUndefined }` into an optional property fails; guard or assert first.
- Vitest mocks of `FoundryClient` must include every method a code path touches (`getCapabilities` bit us once).

## Release process

1. `npm run build && npm test && npm run smoke` (smoke against a live world).
2. Bump versions (root, server, module, desktop, shared, `module.json`) — keep all six identical. Release workflows reject a mismatched tag/manual version.
3. Commit, push, then publish a GitHub release tagged `vX.Y.Z` (target branch can be the feature branch). The complete release workflow attaches the direct Windows Setup executable and available macOS package; the Foundry release workflow attaches its required `module.json` + `module.zip`. Do not publish a standalone/manual server ZIP. The stable Foundry install URL is `releases/latest/download/module.json`.
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
packages/desktop/src/
  main/                 Electron lifecycle, tray/menu/window, backend supervision, config store
  preload.ts            narrow contextBridge API (never expose ipcRenderer or filesystem)
  renderer/             sandboxed dashboard and structured connection editor
packages/desktop/assets/ application/tray icon sources and generated assets
scripts/bridge-smoke-test.mjs   live integration suite (npm run smoke)
scripts/install.mjs             client setup: npm run setup — builds and registers
                                the server with Claude Desktop / Claude Code / Codex
```
