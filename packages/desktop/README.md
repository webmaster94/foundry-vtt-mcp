# Foundry VTT MCP Bridge desktop host

The Electron desktop host owns the notification-area UI and supervises the same persistent backend used by MCP stdio clients.

## Development

Use Node 22.12 or newer for Electron tooling:

```sh
npm run dev:desktop
```

The development command first compiles `packages/mcp-server/dist/backend.js`. This is intentionally the same entry used by source stdio wrappers, so the desktop host and an MCP client never compete over two different daemon builds.

## Windows unpacked payload

```sh
npm run pack:desktop:win
```

The custom NSIS installer consumes `packages/desktop/release/win-unpacked/`. Packaged desktop builds supervise `resources/server/backend.bundle.cjs` and prefer the installer-provided `runtime/node.exe`.

User connection profiles live at `%APPDATA%\FoundryVTT MCP Bridge\foundry-servers.json`. A caller may override that location with an absolute `FOUNDRY_SERVERS_CONFIG` path.
