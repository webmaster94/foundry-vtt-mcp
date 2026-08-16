# Agent-assisted Windows migration

The Windows installer performs the normal migration automatically. It upgrades
installer-owned **Claude Desktop**, **Claude Code**, and **Codex** MCP entries,
preserves connection profiles, and replaces the older Foundry MCP Server
installation without creating a second Programs and Features entry.

Setup can migrate a source-checkout entry automatically when its one script
argument has this repository's exact `packages\mcp-server\dist\index.js` layout
and the root, server, and Foundry module manifests identify this project. It
never deletes or changes that checkout. For safety, setup does not claim custom
launchers, incomplete checkouts, or another installation. Use the instruction
below when you intentionally want to replace one of those preserved entries.

## Copy this instruction to your agent

```text
Migrate this Windows user completely to the installed Foundry VTT MCP Bridge.

Work safely and finish the migration rather than only describing it:

1. Locate the installed product from
   HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryMCPServer.
   Require a valid InstallLocation and these exact files beneath it:
   - FoundryVTT MCP Bridge.exe
   - resources\server\index.bundle.cjs
   Do not download or run another installer and do not trust a path outside that
   validated install root.
2. Use this canonical profile file unless the installed registration already
   provides a valid absolute FOUNDRY_SERVERS_CONFIG path:
   %APPDATA%\FoundryVTT MCP Bridge\foundry-servers.json
   Preserve the canonical file if it exists. If it does not, copy the most recent
   valid foundry-servers.json referenced by an old Foundry MCP entry or found in a
   recognized older installation. Never merge by guessing, never expose authToken
   values in output, and never delete the source file.
3. Find user-level Foundry bridge registrations named foundry-mcp,
   foundry-vtt-mcp, or foundry-vtt-mcp-bridge in:
   - Claude Desktop's standalone and installed MSIX config locations
   - %USERPROFILE%\.claude.json for Claude Code, if present
   - %USERPROFILE%\.codex\config.toml for Codex, if present
   Do not scan or modify project-local configurations.
4. Before changing each file, reject links/reparse points and non-regular files,
   save an exact timestamped backup beside it, parse it successfully, and preserve
   all unrelated settings and MCP servers. Recheck the file immediately before
   replacing it; if another process changed it, stop and report the conflict
   without overwriting either version.
5. Replace the applicable Foundry bridge entry with exactly:
   command = <InstallLocation>\FoundryVTT MCP Bridge.exe
   args = [<InstallLocation>\resources\server\index.bundle.cjs]
   env.ELECTRON_RUN_AS_NODE = 1
   env.FOUNDRY_SERVERS_CONFIG = <canonical absolute profile path>
   env.FOUNDRY_MCP_MANAGED_BY = io.github.webmaster94.foundry-vtt-mcp
   Use the native JSON structure for Claude Desktop/Claude Code and TOML for
   Codex. Preserve each file's encoding, BOM, and newline style where practical.
6. If a supported user config does not exist, do not invent application settings
   for software that may not be installed. Report it as not detected. If the
   client is installed and its user config exists but has no Foundry entry, add
   foundry-mcp without changing other entries.
7. Stop only old Foundry MCP wrapper processes whose executable and single script
   argument exactly match the validated old or current bridge layouts. Never kill
   Node, Electron, Foundry, Claude, Codex, or another process by name alone.
8. Validate all edited JSON/TOML, confirm Programs and Features contains one
   Foundry VTT MCP Bridge entry, confirm only the intended Start Menu folder exists,
   launch the installed bridge once in background mode, and verify its reported
   backend entry path and profile path are under the validated install/config
   locations. Do not print secrets.
9. Tell me which clients were migrated, the backup paths, the profile path used,
   and any entry deliberately left unchanged. Remind me to fully restart each
   migrated MCP client so it reloads its configuration.
```

This instruction deliberately requires exact-path ownership checks and backups.
It must not broadly terminate `node.exe`, delete a source checkout, overwrite
unrelated MCP servers, or remove a connection-profile source after copying it.

## Expected installed entry

The resulting registration launches the GUI-subsystem Electron executable in
Node mode. This is the intended stdio endpoint and does not open a Command Prompt
window:

```text
command: <InstallLocation>\FoundryVTT MCP Bridge.exe
args:    <InstallLocation>\resources\server\index.bundle.cjs
env:     ELECTRON_RUN_AS_NODE=1
         FOUNDRY_SERVERS_CONFIG=%APPDATA%\FoundryVTT MCP Bridge\foundry-servers.json
         FOUNDRY_MCP_MANAGED_BY=io.github.webmaster94.foundry-vtt-mcp
```

After migration, fully exit and reopen Claude Desktop, Claude Code, or Codex.
Keeping the old client process open can keep its previous MCP command cached even
when the configuration file is already correct.
