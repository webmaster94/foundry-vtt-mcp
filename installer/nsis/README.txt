Foundry MCP Server for Windows
==============================

This installer connects MCP clients with Foundry VTT.

Included components
-------------------

* Foundry MCP Server with a bundled Node.js runtime (required)
* Foundry MCP Bridge module (optional, selected by default)
* Claude Desktop configuration helper

After installation
------------------

1. Restart Claude Desktop.
2. Launch Foundry VTT and enable Foundry MCP Bridge in the world.
3. Open the module's Connection settings and confirm the host and port.
4. Confirm the module diagnostics show a connected server.

The installer preserves unrelated Claude Desktop MCP entries. The uninstaller can remove the bridge module and its own configuration entry without deleting worlds, generated maps, or other user-created Foundry data. Upgrades and uninstall remove only the retired per-world enhanced-creature-index.json cache.

Documentation: https://github.com/webmaster94/foundry-vtt-mcp
Issues: https://github.com/webmaster94/foundry-vtt-mcp/issues
