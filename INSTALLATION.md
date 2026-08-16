# Foundry VTT MCP Bridge installation

The bridge has two parts:

1. The `foundry-mcp-bridge` Foundry module runs inside an open GM world.
2. The desktop bridge and its persistent local backend are used by Claude Desktop, Claude Code, Codex, or another MCP client.

The two parts must use the same release version.

## Requirements

- Foundry VTT v13 or v14
- Windows 10 or later for the desktop installer
- A supported MCP client
- A GM account in the world you want to control

## Install the Foundry module

In Foundry, open **Add-on Modules → Install Module** and use:

```text
https://github.com/webmaster94/foundry-vtt-mcp/releases/latest/download/module.json
```

Enable **Foundry MCP Bridge** in the world. Keep the installed folder name and module id as `foundry-mcp-bridge`.

## Install the desktop bridge

### Windows release installer

Download **Foundry VTT MCP Bridge Setup** from the [releases page](https://github.com/webmaster94/foundry-vtt-mcp/releases). Its clearly labeled **Install location** page defaults to your per-user Programs folder and lets you browse to another location. Setup registers a single entry in **Apps & features / Programs and Features**, creates Start Menu shortcuts, and can install the Foundry module. It automatically configures detected user-level Claude Desktop, Claude Code, and Codex clients.

The setup program recognizes the older **Foundry MCP Server** installation. It stops only bridge-owned processes, preserves connection profiles and user data, replaces only installer-owned program files, and updates the existing uninstall registration so duplicate Programs and Features entries are not created.

Launch **Foundry VTT MCP Bridge** from the Start Menu. The dashboard shows every configured Foundry connection and its current state. Backend failures appear only when they need attention. Closing the window leaves the bridge running in the notification area; right-click the tray icon for **Open Foundry VTT MCP Bridge** or **Exit**.

Use the native menu bar to manage the application:

- **File → Exit** gracefully stops the desktop bridge.
- **Edit → Server Connections…** opens the profile editor backed by `foundry-servers.json`.
- **Help → About Foundry VTT MCP Bridge** shows version and project information.

Connection saves are validated for port conflicts and remote-auth requirements, written atomically with a backup, and rolled back if live listener reload fails. Existing authentication tokens are never displayed; the editor can retain, replace, or clear one explicitly.

Restart Claude Desktop, Claude Code, or Codex after setup changes its MCP registration. Installer-managed Windows clients launch the stdio bridge through the desktop executable in background Node mode, so they do not open a Command Prompt window. Setup migrates a source-checkout registration only when the argument path has this project's exact package layout and matching package/module identities. It preserves custom launchers and unverifiable same-name entries; use the repository's copy-pasteable [agent-assisted migration instruction](MIGRATION.md) for those custom cases.

The installed desktop application uses `%APPDATA%\FoundryVTT MCP Bridge\foundry-servers.json` as its canonical profile file. An absolute `FOUNDRY_SERVERS_CONFIG` override remains supported for advanced or portable setups.

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

- Windows: use **Apps & features / Programs and Features → Foundry VTT MCP Bridge**, or the Start Menu uninstall shortcut.
- macOS: run `Uninstall.tool` from the disk image.

The Windows uninstaller stops bridge-owned processes and removes the installed application, shortcuts, and registration. It preserves `%APPDATA%\FoundryVTT MCP Bridge` by default so profiles survive reinstallations. Owned MCP-client cleanup must succeed before it deletes the registered runtime; on a cleanup conflict, interactive uninstall offers retry/cancel and silent uninstall exits non-zero with the application payload intact. The supplied uninstallers remove only bridge-owned application/module files and MCP entries that still point at this installation; they do not remove worlds, user-created content left by older releases, replacement MCP entries, or unrelated software.

Report problems at [GitHub Issues](https://github.com/webmaster94/foundry-vtt-mcp/issues).
