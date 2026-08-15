#!/bin/bash
# Foundry MCP Server uninstaller for macOS.
# Only bridge-owned payloads and configuration entries are removed.

set -u

if [ "$(id -u)" -eq 0 ]; then
  CURRENT_USER=$(stat -f '%Su' /dev/console 2>/dev/null)
else
  CURRENT_USER=$(id -un)
fi
if [ -z "$CURRENT_USER" ] || [ "$CURRENT_USER" = "root" ] || [ "$CURRENT_USER" = "loginwindow" ]; then
  echo "Could not determine the desktop user."
  exit 1
fi

USER_HOME=$(dscl . -read "/Users/$CURRENT_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
if [ -z "$USER_HOME" ]; then
  USER_HOME=$(eval echo ~$CURRENT_USER)
fi

echo "This removes Foundry MCP Server, its Claude Desktop entry, and its Foundry module code."
echo "User-created Foundry content and generated maps are preserved; only the retired Enhanced Creature Index cache is removed."
read -r -p "Continue? [y/N] " response
case "$response" in
  y|Y|yes|YES) ;;
  *) echo "Uninstallation cancelled."; exit 0 ;;
esac

# Stop only processes launched from this application's own bundle.
pkill -f '/Applications/FoundryMCPServer.app/' 2>/dev/null || true

CLAUDE_CONFIG="$USER_HOME/Library/Application Support/Claude/claude_desktop_config.json"
if [ -f "$CLAUDE_CONFIG" ]; then
  cp "$CLAUDE_CONFIG" "$CLAUDE_CONFIG.backup.$(date +%s)"
  NODE_PATH=""
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then NODE_PATH="$candidate"; break; fi
  done
  if [ -n "$NODE_PATH" ]; then
    CLAUDE_CONFIG="$CLAUDE_CONFIG" "$NODE_PATH" <<'NODE_EOF'
const fs = require('fs');
const configPath = process.env.CLAUDE_CONFIG;
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (config.mcpServers && typeof config.mcpServers === 'object') {
  delete config.mcpServers['foundry-mcp'];
  delete config.mcpServers['foundry-vtt-mcp'];
}
const temporaryPath = `${configPath}.tmp-${process.pid}`;
fs.writeFileSync(temporaryPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(temporaryPath, configPath);
NODE_EOF
  else
    echo "Node.js was not found; remove the foundry-mcp entry from Claude Desktop manually."
  fi
fi

for MODULE_PARENT in \
  "$USER_HOME/Library/Application Support/FoundryVTT/Data/modules" \
  "$USER_HOME/Documents/FoundryVTT/Data/modules" \
  "$USER_HOME/FoundryVTT/Data/modules" \
  "$USER_HOME/.local/share/FoundryVTT/Data/modules"; do
  MODULE_PATH="$MODULE_PARENT/foundry-mcp-bridge"
  if [ -L "$MODULE_PATH" ]; then
    echo "Refusing to remove symlinked Foundry module target: $MODULE_PATH"
    continue
  fi

  # Validate the allowlisted modules path before deleting only the retired
  # per-world cache. Generated maps and every other user file are retained.
  if [ -d "$MODULE_PARENT" ] && [ "$(basename "$MODULE_PARENT")" = "modules" ]; then
    FOUNDRY_DATA="${MODULE_PARENT%/modules}"
    if [ -n "$FOUNDRY_DATA" ] && [ "$FOUNDRY_DATA" != "/" ] && [ -d "$FOUNDRY_DATA/modules" ]; then
      for WORLD_DIR in "$FOUNDRY_DATA"/worlds/*; do
        [ -d "$WORLD_DIR" ] || continue
        [ -L "$WORLD_DIR" ] && continue
        if [ -f "$WORLD_DIR/enhanced-creature-index.json" ]; then
          rm -f -- "$WORLD_DIR/enhanced-creature-index.json"
          echo "Removed retired Enhanced Creature Index cache from $(basename "$WORLD_DIR")."
        fi
      done
    fi
  fi

  if [ -f "$MODULE_PATH/module.json" ]; then
    # Remove bridge-owned code and assets, but preserve any user-created files
    # left by older module versions (including generated maps).
    rm -rf "$MODULE_PATH/dist" "$MODULE_PATH/lang" "$MODULE_PATH/scripts" \
      "$MODULE_PATH/styles" "$MODULE_PATH/templates"
    rm -f "$MODULE_PATH/module.json"
    rmdir "$MODULE_PATH" 2>/dev/null || true
  fi
done

sudo rm -rf "/Applications/FoundryMCPServer.app"
rm -rf "$USER_HOME/Library/Application Support/FoundryMCPServer"

for receipt in com.foundry-mcp.core com.foundry-mcp.foundry-module com.foundry-mcp.comfyui; do
  sudo pkgutil --forget "$receipt" >/dev/null 2>&1 || true
done

echo "Foundry MCP Server was removed. Restart Claude Desktop to reload its configuration."
