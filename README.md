# Foundry VTT MCP Bridge — Extended Fork

Connect Foundry VTT to AI agents (Claude Desktop, Claude Code, or any MCP client) for AI-powered campaign management through the Model Context Protocol.

This is [webmaster94's fork](https://github.com/webmaster94/foundry-vtt-mcp) of [adambdooley/foundry-vtt-mcp](https://github.com/adambdooley/foundry-vtt-mcp), extended with a much deeper Foundry integration: a generic document API with dry-run and undo, one-call NPC building, batch operations, system-data compendium search, GM-browser script execution, event streaming, and multi-server support. It keeps the useful upstream quest, dice-coordination, campaign-dashboard, and system-support capabilities while adding support for D&D 5e, Pathfinder 2e, DSA5, Cosmere RPG, WFRP4e, and Mongoose Traveller 2e workflows.

The tool catalog is verified by unit tests and a live integration suite before release, with a CI-enforced 70KB schema ceiling to keep MCP client context use bounded.

## Installation

### 1. Install the Foundry module

In Foundry VTT: **Add-on Modules → Install Module**, paste this manifest URL:

```
https://github.com/webmaster94/foundry-vtt-mcp/releases/latest/download/module.json
```

Enable **Foundry MCP Bridge** in your world's Module Management. Do not rename the module folder — the id `foundry-mcp-bridge` is load-bearing for socket routing. Updating over the upstream module works in place (same id).

### 2. Install the desktop bridge and connect your AI

On Windows, download **Foundry VTT MCP Bridge Setup** from the
[latest release](https://github.com/webmaster94/foundry-vtt-mcp/releases/latest). The installer:

- installs the bridge in your per-user Programs folder and registers it in **Apps & features / Programs and Features**;
- adds **Foundry VTT MCP Bridge** and its uninstaller to the Start Menu;
- upgrades the older Foundry MCP Server installation in place without deleting connection profiles, Foundry worlds, or unrelated MCP-client entries;
- installs the Foundry module when selected and automatically configures detected user-level Claude Desktop, Claude Code, and Codex clients without replacing their other servers.

Launch **Foundry VTT MCP Bridge** from the Start Menu. Its dashboard shows every configured profile and whether a Foundry GM client is connected. Closing the window keeps the bridge in the notification area. Right-click its tray icon to reopen it or exit. The native **Edit → Server Connections…** command opens the profile editor; **Help → About** shows the installed version and attribution.

The authentication token for a profile stays masked in the editor. Connection changes are validated, written atomically, and applied live; if a listener cannot be restarted, the prior configuration is restored.

Restart Claude Desktop, Claude Code, or Codex after installation so it loads the installer-managed MCP entry. On Windows that entry runs through the desktop executable in background Node mode, so normal MCP startup does not open a Command Prompt window. Source/development entries are deliberately left untouched because the installer cannot safely claim them. To intentionally replace one of those preserved entries, give an agent the copy-pasteable [agent-assisted migration instruction](MIGRATION.md) after setup finishes.

### Source installation

Full monorepo or desktop development requires Node.js 22.12 or later and git. The prebuilt standalone/headless MCP server remains compatible with Node.js 18 or later; `npm run setup` builds only the shared and server workspaces when that server output is missing.

Navigate to the folder you wish to run your agent from.

Then it's three commands:

```bash
git clone https://github.com/webmaster94/foundry-vtt-mcp.git
cd foundry-vtt-mcp
npm install && npm run setup
```

`npm run setup` builds the headless server and **automatically registers it with every AI client it finds on your machine**:

| Client             | How it's configured                                                     |
| ------------------ | ----------------------------------------------------------------------- |
| **Claude Desktop** | adds `foundry-mcp` to `claude_desktop_config.json` (backup saved first) |
| **Claude Code**    | `claude mcp add` at user scope — works from any folder                  |
| **Codex CLI**      | `codex mcp add` (or `~/.codex/config.toml` on older versions)           |

Restart your AI client and open the Foundry world as a GM; the tools appear without a browser refresh. The connection is self-healing: the server side runs as a persistent background process that survives AI-client restarts and idle periods, native/application heartbeats remove dead transports, the module retries forever, and browser resume/network events wake delayed retries immediately. A freshly started server waits for the module rather than failing your first prompt. Re-running setup is safe — existing entries are updated in place, and a `foundry-servers.json` (see below) is picked up automatically. `npm run stop` shuts the background process down if you ever need to.

The desktop application is a secure controller for this same singleton backend; it does not create a second bridge or replace the stdio MCP endpoint. Headless source installs and existing MCP-client configurations therefore continue to work.

An ordinary Foundry module cannot execute world APIs with no client loaded. Keep one authenticated GM browser or desktop-client world open. A normal inactive tab remains connected, but a browser-frozen or discarded tab cannot execute JavaScript until the browser resumes it; the bridge reconnects automatically on resume.

Options: `node scripts/install.mjs --clients claude-desktop,codex` to configure specific clients only, `--list` to preview without changing anything.

> The module and server versions must match. Version mismatches produce a clear `VERSION_MISMATCH` error instead of silently invoking an incompatible handler.

<details>
<summary><strong>Manual configuration</strong> (if you prefer, or for other MCP clients)</summary>

The server entry point is `packages/mcp-server/dist/index.js`; any MCP client that can run a stdio server works.

**Claude Desktop** — `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\`, macOS: `~/Library/Application Support/Claude/`, Linux: `~/.config/Claude/`):

```json
{
  "mcpServers": {
    "foundry-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/foundry-vtt-mcp/packages/mcp-server/dist/index.js"]
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add foundry-mcp --scope user -- node /absolute/path/to/foundry-vtt-mcp/packages/mcp-server/dist/index.js
```

**Codex CLI** — `~/.codex/config.toml`:

```toml
[mcp_servers.foundry-mcp]
command = "node"
args = ["/absolute/path/to/foundry-vtt-mcp/packages/mcp-server/dist/index.js"]
```

Optional environment variables: `FOUNDRY_HOST` / `FOUNDRY_PORT` (default `localhost:31415`), `FOUNDRY_SERVERS_CONFIG` (path to a multi-server profile file).

</details>

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
      "remoteMode": false,
      "authToken": "replace-with-a-long-random-shared-secret"
    },
    "local": { "label": "Local dev world", "port": 31417, "connectionType": "websocket" }
  }
}
```

With the desktop installation, this configuration lives at `%APPDATA%\FoundryVTT MCP Bridge\foundry-servers.json`. Use **Edit → Server Connections…** instead of editing it by hand; the application still uses the same JSON schema and keeps a backup beside the file.

Each profile listens on its own port; point each world's module settings at its profile's port (WebRTC signaling uses `port + 1`). Forge still uses `remoteMode: false` when the Forge browser and MCP server run on the same workstation: the HTTPS page connects to that workstation's loopback interface. Chrome may show a Local Network Access prompt; allow it for the Forge site. Use `remoteMode: true` only when a browser on another machine must reach the listener, set the module's **Bridge Server Host** to that server's private IP or `.local` name, and protect the exposure with an auth token and host firewall. Then:

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
`search-compendium-contents` — bounded search over live compendium data with filters on real system fields (`{"path": "system.level", "op": "lte", "value": 3}`) and optional description full-text. It complements the lightweight name-based `search-compendium` tool without maintaining a duplicate world index.

**Combat & events (fork, v0.11)**
`roll-initiative`, `apply-damage` / `apply-healing` (temp-HP aware, undoable), `add-active-effect` (buffs/debuffs with durations). Foundry pushes game events to the server — `wait-for-event` / `get-recent-events` react to combat turns, chat messages, and dice results; `get-roll-results` finally makes player roll outcomes visible to the agent.

**Scenes & assets (fork, v0.11)**
`build-scene-from-spec` (background, grid, lights, walls, tokens by actor name in one call), `build-actors-from-spec` (whole encounters/parties, one undo group), token placement + token art from `build-actor-from-spec`, `browse-assets` / `upload-asset` for portraits and battle maps.

**Automation (fork)**
`execute-foundry-script` (JavaScript in the GM browser), macro CRUD + `execute-macro`, browser console capture (`get-browser-console`), `get-bridge-logs` (server self-diagnosis), `get-bridge-recipes` (curated dnd5e NPC math, combat-loop, and API patterns for agents).

**Security**
Shared-secret auth: set the module's _Bridge Auth Token_ and the matching `authToken` in the server profile — unauthenticated connections are rejected before transport setup. The module token is browser-local so players cannot read it from world settings; configure it in every GM browser/device that may own the bridge. Use a long random token for Forge/browser-hosted worlds; any remote (`0.0.0.0`) listener refuses to start without a token of at least 16 characters. Loopback binding remains the default.

**Inherited from upstream**
Characters and inventories, scenes and tokens (movement, conditions, updates), compendium browsing, quest journals and campaign dashboards, interactive player dice requests, actor ownership, actor creation from compendium, and system-specific suites for D&D 5e NPCs, DSA5 archetypes, WFRP4e actor editing, and Mongoose Traveller 2e character/schema handling.

## Example Usage

- _"Build the four Separatist NPCs from my notes as actors in the Mine folder"_ — one `build-actor-from-spec` call each
- _"Find all abjuration spells of level 3 or lower"_ — `search-compendium-contents`
- _"Bump the whole party's HP by 10, but show me the diff first"_ — `dryRun`, then apply
- _"Undo that"_ — `undo-last-mcp-operation`
- _"Switch to the local test server and rerun it"_ — `use-foundry-server`
- Other examples: _"Roll a stealth check for Tulkas"_, _"Create a quest about the missing villagers"_, _"Build a tavern scene using assets from my Foundry data folder"_

## Module Settings

The module exposes separate **Connection**, **Permissions & Safety**, **Console & Diagnostics**, and **Advanced API** windows so the normal Foundry settings list stays compact. These controls cover connection type (auto / WebSocket / WebRTC), server host/port and authentication, **Allow Write Operations** (read-only mode), request limits, audit retention, browser-script permission, notifications, and reconnect behavior. Write operations are GM-only by design; non-GM users get no bridge access at all.

## Development

```bash
npm run build        # all workspaces (shared, server, module, desktop)
npm test             # unit tests (vitest)
npm run pack:desktop:win # build the unpacked Windows desktop application
npm run test:fork-contract # baseline fork capabilities retained; only approved removals absent
npm run smoke        # 27-step LIVE integration suite — needs a running,
                     # connected world; run before every release
```

Version tags (`vX.Y.Z`) run the complete release pipeline, which verifies the live-tested source gates and attaches the Windows Setup executable, Foundry `module.json`/`module.zip`, standalone server bundles, and available macOS packages to the GitHub release ([workflow](.github/workflows/build-complete-release.yml)). The stable Foundry manifest URL remains `releases/latest/download/module.json`.

Agent-oriented contributor documentation (architecture map, conventions, gotchas, how to add a tool end to end) lives in [AGENTS.md](AGENTS.md).

## Credits & License

Built on [Foundry VTT MCP](https://github.com/adambdooley/foundry-vtt-mcp) by [Adam Dooley](https://github.com/adambdooley) — the original installer, quest/campaign systems, and core bridge architecture are his work. Watch his [video overview](https://youtu.be/Se04A21wrbE) for the original project.

MIT licensed, like upstream.
