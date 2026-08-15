# Foundry VTT MCP Bridge installation

The bridge has two parts:

1. The `foundry-mcp-bridge` Foundry module runs inside an open GM world.
2. The MCP server is a persistent local process used by Claude Desktop, Claude Code, Codex, or another MCP client.

The two parts must use the same release version.

## Requirements

- Foundry VTT v13 or v14
- Node.js 18 or later for source/manual installation
- A supported MCP client
- A GM account in the world you want to control

## Install the Foundry module

In Foundry, open **Add-on Modules → Install Module** and use:

```text
https://github.com/webmaster94/foundry-vtt-mcp/releases/latest/download/module.json
```

Enable **Foundry MCP Bridge** in the world. Keep the installed folder name and module id as `foundry-mcp-bridge`.

## Install the MCP server

### Release installer

Download the current Windows installer or macOS disk image from the [releases page](https://github.com/webmaster94/foundry-vtt-mcp/releases). The installers include the MCP server, can install the Foundry module, and configure Claude Desktop without replacing unrelated MCP entries.

### Repository setup

```bash
git clone https://github.com/webmaster94/foundry-vtt-mcp.git
cd foundry-vtt-mcp
npm install
npm run setup
```

`npm run setup` builds the workspaces and registers the server with supported clients it finds. Restart the MCP client after setup. Use `node scripts/install.mjs --list` to preview detected clients or `--clients claude-desktop,codex` to limit configuration.

### Manual MCP client configuration

Build first with `npm install && npm run build`, then point the client at the absolute path to `packages/mcp-server/dist/index.js`:

```json
{
  "mcpServers": {
    "foundry-mcp": {
      "command": "node",
      "args": ["C:/absolute/path/foundry-vtt-mcp/packages/mcp-server/dist/index.js"]
    }
  }
}
```

The default listener is `localhost:31415`. Optional variables include `FOUNDRY_HOST`, `FOUNDRY_PORT`, and `FOUNDRY_SERVERS_CONFIG`.

## Configure the module

In **Game Settings → Configure Settings**, use the category buttons under **Foundry MCP Bridge**:

- **Connection**: enable the bridge, choose WebSocket/WebRTC/automatic transport, and set host, port, authentication, recovery, and notification behavior.
- **Permissions & Safety**: allow or deny writes, set bulk limits and protected document types, control auditing, and configure event delivery.
- **Console & Diagnostics**: configure bounded browser-console capture and idle suspension.
- **Advanced API**: control browser-script execution and serialized-response limits.

For a local HTTP world, use WebSocket with `localhost` and the matching profile port. Forge or another HTTPS-hosted browser normally uses WebRTC; signaling listens on the configured port plus one. When the browser and MCP server are on the same workstation, keep the server profile at `remoteMode: false` even though the world is hosted remotely—the browser connects to its own loopback interface. Chrome may request Local Network Access permission for the Forge site.

Set a long random **Bridge Auth Token** in the module and the identical `authToken` in the matching server profile. The module stores this secret only in the current browser, not in player-readable world settings, so configure it on each GM browser/device that may own the bridge. This is strongly recommended for any browser-hosted world. `remoteMode: true` refuses to start without a token of at least 16 characters; it binds beyond loopback and is only needed when the GM browser runs on a different machine. In that case, set the module's **Bridge Server Host** to the server's private IP or `.local` name and allow the browser's Local Network Access prompt.

## Connection lifetime

The MCP backend is a persistent daemon and the module retries indefinitely after disconnects. Closing or restarting an MCP client does not tear down the Foundry connection. Native/application heartbeats remove dead transports, duplicate tabs wait and retry instead of stealing ownership, and online/pageshow/visibility recovery wakes retries after background suspension.

Foundry module code only runs while a GM has the world open in a browser or desktop client; a world with no connected GM cannot service bridge queries. Inactive tabs normally continue working. If the browser freezes or discards a tab, no JavaScript can execute until it resumes; the bridge reconnects automatically when that happens.

## Verify

1. Confirm the module diagnostics show a connected profile.
2. Confirm `foundry-mcp` appears in the MCP client.
3. Ask the client to list Foundry servers, then list a small set of actors or scenes.
4. Before release, run `npm run build`, `npm test`, and the live `npm run smoke` suite against a connected test world.

If the ports match but the bridge does not reconnect, verify that exactly one world is using each profile port, a GM browser tab is still loaded, the module/server auth tokens match, and the browser granted Local Network Access where required. Refreshing the tab should not be needed for ordinary recovery.

## Uninstall

- Windows: use **Add or Remove Programs → Foundry MCP Server**.
- macOS: run `Uninstall.tool` from the disk image.
- Manual install: run `npm run stop`, remove the repository, remove the `foundry-mcp` client entry, and uninstall the Foundry module.

The supplied uninstallers remove only bridge-owned application/module files and the bridge's MCP configuration entry. They do not remove worlds, user-created content left by older releases, or unrelated software.

Report problems at [GitHub Issues](https://github.com/webmaster94/foundry-vtt-mcp/issues).
