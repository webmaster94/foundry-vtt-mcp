Foundry VTT MCP Bridge for Windows
==================================

This installer provides the desktop dashboard, notification-area host,
persistent MCP backend, MCP wrapper, and optional Foundry VTT module.

After installation
------------------

1. Open Foundry VTT MCP Bridge from the Start Menu.
2. Review or edit server profiles from Edit > Server Connections.
3. Enable Foundry MCP Bridge in each Foundry world you want to expose.
4. Restart an MCP client after its configuration changes.

Installer-managed MCP clients run the desktop executable in background Node
mode. Normal MCP startup should not open a Command Prompt window.

Claude Desktop is configured automatically when possible. Existing user-scope
Claude Code and Codex configurations are migrated only when the bridge entry is
installer-owned or absent. Foreign same-name and source/development entries are
preserved; setup keeps a prior bridge payload if a safe migration is refused.

Server profiles are stored at:

  %APPDATA%\FoundryVTT MCP Bridge\foundry-servers.json

That entire settings directory is preserved during upgrades and uninstall.
Before deleting the application payload, uninstall requires its owned Claude
Desktop, Claude Code, and Codex entries to be removed safely; a cleanup failure
leaves the registered runtime installed for retry. Foundry module removal is
optional. Unrelated MCP entries, worlds, generated maps, unknown files, and
other user-created Foundry data are not removed. The retired per-world
enhanced-creature-index.json cache is the only world-data file cleaned.

This is an unofficial community project. It is not affiliated with, endorsed
by, verified by, or sponsored by Foundry Gaming LLC. See
THIRD_PARTY_NOTICES.md for Foundry VTT brand and asset terms.

Documentation: https://github.com/webmaster94/foundry-vtt-mcp
Issues: https://github.com/webmaster94/foundry-vtt-mcp/issues
