# Foundry VTT MCP Bridge — Extended Fork

Connect Foundry VTT to AI agents (Claude Desktop, Claude Code, or any MCP client) for AI-powered campaign management through the Model Context Protocol.

This is [webmaster94's fork](https://github.com/webmaster94/foundry-vtt-mcp) of [adambdooley/foundry-vtt-mcp](https://github.com/adambdooley/foundry-vtt-mcp), extended with a much deeper Foundry integration: a generic document API with dry-run and undo, one-call NPC building, batch operations, system-data compendium search, GM-browser script execution, and multi-server support. It tracks upstream (currently v0.8.2 merged) and keeps all upstream features: quests, dice coordination, map generation, campaign dashboards, and system support for D&D 5e, Pathfinder 2e, DSA5, Cosmere RPG, and WFRP4e.

**108 MCP tools** as of v0.10, verified by a live integration suite before each release.

## Installation

### 1. Install the Foundry module

In Foundry VTT: **Add-on Modules → Install Module**, paste this manifest URL:

```
https://github.com/webmaster94/foundry-vtt-mcp/releases/latest/download/module.json
```

Enable **Foundry MCP Bridge** in your world's Module Management. Do not rename the module folder — the id `foundry-mcp-bridge` is load-bearing for socket routing. Updating over the upstream module works in place (same id).

### 2. Install the MCP server

Requires Node.js 18+.

```bash
git clone https://github.com/webmaster94/foundry-vtt-mcp.git
cd foundry-vtt-mcp
npm install
npm run build
```

> Upstream's Windows/Mac installers work but ship the upstream (unextended) versions of both components. For this fork, build from source; the module and server versions must match (mismatches produce clear `VERSION_MISMATCH` errors rather than silent failures).

### 3. Connect your AI client

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "foundry-mcp": {
      "command": "node",
      "args": ["path/to/foundry-vtt-mcp/packages/mcp-server/dist/index.js"],
      "env": { "FOUNDRY_HOST": "localhost", "FOUNDRY_PORT": "31415" }
    }
  }
}
```

**Claude Code** — from any project:

```bash
claude mcp add foundry-mcp -- node path/to/foundry-vtt-mcp/packages/mcp-server/dist/index.js
```

Start (or refresh) your Foundry world; the module connects to the MCP server within ~30 seconds and reconnects automatically after either side restarts.

## Multiple Foundry Servers

The MCP server can hold connections to several Foundry instances at once (e.g. a live Forge campaign and a local test world). Define friendly-named profiles in `foundry-servers.json` (see [`foundry-servers.example.json`](foundry-servers.example.json)) next to the server, or point `FOUNDRY_SERVERS_CONFIG` at the file:

```json
{
  "defaultServer": "forge",
  "servers": {
    "forge": {
      "label": "My Forge Campaign",
      "port": 31415,
      "connectionType": "webrtc",
      "remoteMode": true
    },
    "local": { "label": "Local dev world", "port": 31417, "connectionType": "websocket" }
  }
}
```

Each profile listens on its own port; point each world's module settings at its profile's port (WebRTC signaling uses `port + 1`). Then:

- `list-foundry-servers` — profiles, connection state, and the world/system/module version each connection reports
- `use-foundry-server` — switch every subsequent call
- `server: "<name>"` on **any** tool call — one-off override without switching
- `reconnect-foundry-server` / `reload-foundry-servers-config` — fix stuck connections and apply config edits live

Without a config file, behavior is identical to upstream: one server from environment variables.

## Tool Catalog (highlights)

**Generic document API (fork)**
`list-document-types`, `list-documents`, `get-document`, `create-document`, `update-document`, `delete-document`, embedded-document equivalents, `get-document-schema` (clean dotted field paths), `query-foundry-data`, `move-document-to-folder`, plus typed wrappers (`create-folder`, `create-roll-table`, `create-playlist`, `create-card-stack`, combat/playlist/cards actions...).

**Safety (fork)**
`dryRun: true` on update/delete returns a before/after diff without applying. `undo-last-mcp-operation` reverts the last write. `get-mcp-audit-log` shows every write with payload summaries; all writes record inverse operations.

**Bulk & building (fork)**
`build-actor-from-spec` — a complete NPC in one call: compendium template clone, stat overrides, spells/items resolved by name, custom features, folder filing. `create-embedded-documents` (up to 100 at once), `batch-document-operations` (ordered sequences of up to 50 ops).

**Search (fork)**
`search-compendium-contents` — filters on real system data (`{"path": "system.level", "op": "lte", "value": 3}`), optional description full-text. Complements upstream's name-based `search-compendium` and the enhanced creature index.

**Automation (fork)**
`execute-foundry-script` (JavaScript in the GM browser), macro CRUD + `execute-macro`, browser console capture (`get-browser-console`), `get-bridge-recipes` (curated dnd5e NPC math and API patterns for agents).

**Inherited from upstream**
Characters and inventories, scenes and tokens (movement, conditions, updates), compendium browsing, quest journals and campaign dashboards, interactive player dice requests, actor ownership, actor creation from compendium, AI map generation via ComfyUI, and system-specific suites for D&D 5e NPCs, DSA5 archetypes, and WFRP4e actor editing.

## Example Usage

- _"Build the four Separatist NPCs from my notes as actors in the Mine folder"_ — one `build-actor-from-spec` call each
- _"Find all abjuration spells of level 3 or lower"_ — `search-compendium-contents`
- _"Bump the whole party's HP by 10, but show me the diff first"_ — `dryRun`, then apply
- _"Undo that"_ — `undo-last-mcp-operation`
- _"Switch to the local test server and rerun it"_ — `use-foundry-server`
- Everything upstream: _"Roll a stealth check for Tulkas"_, _"Create a quest about the missing villagers"_, _"Generate a riverside cottage battlemap"_

## Module Settings

The module's settings menu covers: enable/disable the bridge, connection type (auto / WebSocket / WebRTC) and server host/port, **Allow Write Operations** (read-only mode), max actors per request, audit log retention, browser script execution permission, enhanced creature index, map generation service, notifications, and reconnect behavior. Write operations are GM-only by design; non-GM users get no bridge access at all.

## Development

```bash
npm run build        # all workspaces (shared, server, module)
npm test             # unit tests (vitest)
npm run smoke        # 16-step LIVE integration suite — needs a running,
                     # connected world; run before every release
```

Releases follow the [League of Foundry Developers](https://github.com/League-of-Foundry-Developers) pattern: publish a GitHub release tagged `vX.Y.Z` and CI builds, stamps, zips, and attaches `module.json` + `module.zip` ([workflow](.github/workflows/module-release.yml)).

Agent-oriented contributor documentation (architecture map, conventions, gotchas, how to add a tool end to end) lives in [AGENTS.md](AGENTS.md).

## Credits & License

Built on [Foundry VTT MCP](https://github.com/adambdooley/foundry-vtt-mcp) by [Adam Dooley](https://github.com/adambdooley) — the installer, map generation, quest/campaign systems, and the core bridge architecture are his work. Watch his [video overview](https://youtu.be/Se04A21wrbE) for the original project.

MIT licensed, like upstream.
