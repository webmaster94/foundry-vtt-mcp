# Build the macOS installer and disk image

The macOS distribution contains the MCP server, the optional Foundry MCP Bridge module, documentation, and a bridge-only uninstaller.

## Requirements

- macOS 11 or later
- Node.js 18 or later
- Xcode Command Line Tools (`xcode-select --install`)
- repository dependencies installed with `npm install`

## Build

From the repository root:

```bash
npm run build
npm run build:bundle --workspace=packages/mcp-server
cd installer
node build-mac-pkg.js
node build-dmg.js
```

The resulting files are written under `installer/build/`:

- `FoundryMCPServer-<version>-macOS.pkg`
- `FoundryMCPServer-<version>.dmg`

The PKG has two choices: the required MCP server and the Foundry module, selected by default. The disk image also includes `README.txt` and `Uninstall.tool`.

## Verify

Test on a clean macOS user account when possible:

1. Open the DMG and install the PKG.
2. Confirm `/Applications/FoundryMCPServer.app` contains both server bundles.
3. Confirm the existing Claude Desktop JSON remains valid and unrelated MCP entries remain present.
4. Confirm the module installs only into a detected Foundry modules directory.
5. Restart Claude Desktop and connect a GM world.
6. Run the live bridge smoke test.
7. Run `Uninstall.tool` and verify only bridge-owned application/module/config data is removed.

For a signed public build, sign the component packages and final product with the appropriate Developer ID Installer identity, notarize the DMG, and staple the notarization ticket before release.
