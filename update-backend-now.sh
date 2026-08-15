#!/bin/bash
# Replace the installed macOS backend bundle with the repository build.

set -euo pipefail

SOURCE="packages/mcp-server/dist/backend.bundle.cjs"
DESTINATION="/Applications/FoundryMCPServer.app/Contents/Resources/foundry-mcp-server/backend.bundle.cjs"

if [ ! -f "$SOURCE" ]; then
  echo "Missing $SOURCE. Run npm run build first."
  exit 1
fi
if [ ! -d "/Applications/FoundryMCPServer.app/Contents/Resources/foundry-mcp-server" ]; then
  echo "FoundryMCPServer.app is not installed in /Applications."
  exit 1
fi

sudo install -m 0644 "$SOURCE" "$DESTINATION"
echo "Backend bundle updated. Restart the MCP backend or invoke a tool so the wrapper can reload it."
