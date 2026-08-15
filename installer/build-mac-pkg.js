#!/usr/bin/env node

/**
 * Build the macOS product installer.
 *
 * Components:
 * 1. MCP server (required)
 * 2. Foundry VTT module (optional, selected by default)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const VERSION = process.env.VERSION || require('../package.json').version;
const ROOT_DIR = path.join(__dirname, '..');
const BUILD_DIR = path.join(__dirname, 'build');
const CORE_ROOT = path.join(BUILD_DIR, 'core-pkg-root');
const FOUNDRY_ROOT = path.join(BUILD_DIR, 'foundry-pkg-root');
const CORE_PKG = path.join(BUILD_DIR, 'FoundryMCP-Core.pkg');
const FOUNDRY_PKG = path.join(BUILD_DIR, 'FoundryMCP-FoundryModule.pkg');
const FINAL_PKG = path.join(BUILD_DIR, `FoundryMCPServer-${VERSION}-macOS.pkg`);

function copyRecursive(source, destination) {
  if (!fs.existsSync(source)) return;
  if (fs.statSync(source).isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyRecursive(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  fs.copyFileSync(source, destination);
}

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

function writeExecutable(file, contents) {
  fs.writeFileSync(file, contents);
  fs.chmodSync(file, 0o755);
}

console.log(`Building Foundry MCP Server ${VERSION} for macOS`);
fs.mkdirSync(BUILD_DIR, { recursive: true });
for (const buildArtifact of [CORE_ROOT, FOUNDRY_ROOT, CORE_PKG, FOUNDRY_PKG, FINAL_PKG]) {
  fs.rmSync(buildArtifact, { recursive: true, force: true });
}

const resolveUserSnippet = `# Resolve the logged-in GUI user (the installer runs as root).
CURRENT_USER=$(stat -f '%Su' /dev/console 2>/dev/null)
if [ -z "$CURRENT_USER" ] || [ "$CURRENT_USER" = "root" ] || [ "$CURRENT_USER" = "loginwindow" ]; then
  CURRENT_USER=$(scutil <<< "show State:/Users/ConsoleUser" 2>/dev/null | awk '/Name :/ && ! /loginwindow/ { print $3 }')
fi
if [ -z "$CURRENT_USER" ] || [ "$CURRENT_USER" = "root" ]; then
  echo "Could not determine the logged-in user; skipping per-user configuration."
  exit 0
fi
USER_HOME=$(dscl . -read "/Users/$CURRENT_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
if [ -z "$USER_HOME" ]; then
  USER_HOME=$(eval echo ~$CURRENT_USER)
fi`;

// Core server payload and Claude Desktop configuration.
const coreResources = path.join(
  CORE_ROOT,
  'Applications',
  'FoundryMCPServer.app',
  'Contents',
  'Resources'
);
const serverDestination = path.join(coreResources, 'foundry-mcp-server');
const serverDist = path.join(ROOT_DIR, 'packages', 'mcp-server', 'dist');
fs.mkdirSync(serverDestination, { recursive: true });

for (const [sourceName, destinationName] of [
  ['backend.bundle.cjs', 'backend.bundle.cjs'],
  ['index.bundle.cjs', 'index.cjs'],
]) {
  const source = path.join(serverDist, sourceName);
  if (!fs.existsSync(source)) {
    throw new Error(`${sourceName} not found. Run npm run build:bundle first.`);
  }
  fs.copyFileSync(source, path.join(serverDestination, destinationName));
}
fs.copyFileSync(
  path.join(ROOT_DIR, 'packages', 'mcp-server', 'package.json'),
  path.join(serverDestination, 'package.json')
);

const coreScripts = path.join(BUILD_DIR, 'core-scripts');
fs.mkdirSync(coreScripts, { recursive: true });
writeExecutable(
  path.join(coreScripts, 'postinstall'),
  `#!/bin/bash
${resolveUserSnippet}

CLAUDE_CONFIG_DIR="$USER_HOME/Library/Application Support/Claude"
CLAUDE_CONFIG="$CLAUDE_CONFIG_DIR/claude_desktop_config.json"
APP_SUPPORT="$USER_HOME/Library/Application Support/FoundryMCPServer"
SERVER_PATH="/Applications/FoundryMCPServer.app/Contents/Resources/foundry-mcp-server/index.cjs"

mkdir -p "$CLAUDE_CONFIG_DIR" "$APP_SUPPORT"
chown "$CURRENT_USER:staff" "$CLAUDE_CONFIG_DIR" "$APP_SUPPORT"

if [ -f "$CLAUDE_CONFIG" ]; then
  cp "$CLAUDE_CONFIG" "$CLAUDE_CONFIG.backup.$(date +%s)"
fi

NODE_PATH=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -x "$candidate" ]; then
    NODE_PATH="$candidate"
    break
  fi
done
if [ -z "$NODE_PATH" ] && command -v node >/dev/null 2>&1; then
  NODE_PATH=$(command -v node)
fi

if [ -n "$NODE_PATH" ]; then
  CLAUDE_CONFIG="$CLAUDE_CONFIG" SERVER_PATH="$SERVER_PATH" NODE_PATH="$NODE_PATH" "$NODE_PATH" <<'NODE_EOF'
const fs = require('fs');
const configPath = process.env.CLAUDE_CONFIG;
let config = {};
if (fs.existsSync(configPath)) {
  const contents = fs.readFileSync(configPath, 'utf8').trim();
  if (contents) config = JSON.parse(contents);
}
if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) {
  config.mcpServers = {};
}
config.mcpServers['foundry-mcp'] = {
  command: process.env.NODE_PATH,
  args: [process.env.SERVER_PATH],
  env: { FOUNDRY_HOST: 'localhost', FOUNDRY_PORT: '31415' }
};
const temporaryPath = configPath + '.tmp-' + process.pid;
fs.writeFileSync(temporaryPath, JSON.stringify(config, null, 2) + '\\n', { mode: 0o600 });
fs.renameSync(temporaryPath, configPath);
NODE_EOF
  MERGE_STATUS=$?
  if [ "$MERGE_STATUS" -ne 0 ]; then
    echo "Claude Desktop configuration is not valid JSON; it was left unchanged and a backup was saved."
    exit 0
  fi
else
  echo "Node.js was not found; server files were installed but Claude Desktop was not configured."
  exit 0
fi

chown "$CURRENT_USER:staff" "$CLAUDE_CONFIG"
chmod 600 "$CLAUDE_CONFIG"
echo "Foundry MCP Server configured for Claude Desktop."
exit 0
`
);

run('pkgbuild', [
  '--root',
  CORE_ROOT,
  '--scripts',
  coreScripts,
  '--identifier',
  'com.foundry-mcp.core',
  '--version',
  VERSION,
  '--install-location',
  '/',
  CORE_PKG,
]);

// Optional Foundry module payload and installation.
const foundryResources = path.join(
  FOUNDRY_ROOT,
  'Applications',
  'FoundryMCPServer.app',
  'Contents',
  'Resources'
);
const moduleSource = path.join(ROOT_DIR, 'packages', 'foundry-module');
const moduleDestination = path.join(foundryResources, 'foundry-module');
if (!fs.existsSync(path.join(moduleSource, 'dist'))) {
  throw new Error('Foundry module dist not found. Run npm run build first.');
}
fs.mkdirSync(moduleDestination, { recursive: true });
for (const folder of ['dist', 'lang', 'scripts', 'styles', 'templates']) {
  copyRecursive(path.join(moduleSource, folder), path.join(moduleDestination, folder));
}
fs.copyFileSync(
  path.join(moduleSource, 'module.json'),
  path.join(moduleDestination, 'module.json')
);

const foundryScripts = path.join(BUILD_DIR, 'foundry-scripts');
fs.mkdirSync(foundryScripts, { recursive: true });
writeExecutable(
  path.join(foundryScripts, 'postinstall'),
  `#!/bin/bash
${resolveUserSnippet}

MODULE_SOURCE="/Applications/FoundryMCPServer.app/Contents/Resources/foundry-module"
FOUNDRY_PATHS=(
  "$USER_HOME/Library/Application Support/FoundryVTT/Data/modules"
  "$USER_HOME/Documents/FoundryVTT/Data/modules"
  "$USER_HOME/FoundryVTT/Data/modules"
  "$USER_HOME/.local/share/FoundryVTT/Data/modules"
)

for FOUNDRY_PATH in "\${FOUNDRY_PATHS[@]}"; do
  if [ -d "$FOUNDRY_PATH" ]; then
    MODULE_DEST="$FOUNDRY_PATH/foundry-mcp-bridge"
    if [ -L "$MODULE_DEST" ]; then
      echo "Refusing to replace symlinked Foundry module target: $MODULE_DEST"
      continue
    fi

    # The path list is allowlisted and must resolve to a modules directory
    # before touching world data. Remove only the retired per-world cache.
    if [ "$(basename "$FOUNDRY_PATH")" = "modules" ]; then
      FOUNDRY_DATA="\${FOUNDRY_PATH%/modules}"
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

    mkdir -p "$MODULE_DEST"
    # Replace module-owned code and assets while preserving user-created data
    # from older releases (notably generated-maps).
    rm -rf "$MODULE_DEST/dist" "$MODULE_DEST/lang" "$MODULE_DEST/scripts" \
      "$MODULE_DEST/styles" "$MODULE_DEST/templates"
    if cp -R "$MODULE_SOURCE/." "$MODULE_DEST/"; then
      chown -R "$CURRENT_USER:staff" "$MODULE_DEST"
      echo "Foundry MCP Bridge installed to $MODULE_DEST"
      exit 0
    fi
  fi
done

echo "Foundry VTT data directory was not found. Install the module from the release manifest instead."
exit 0
`
);

run('pkgbuild', [
  '--root',
  FOUNDRY_ROOT,
  '--scripts',
  foundryScripts,
  '--identifier',
  'com.foundry-mcp.foundry-module',
  '--version',
  VERSION,
  '--install-location',
  '/',
  FOUNDRY_PKG,
]);

const welcome = `<!doctype html>
<html><body>
<h1>Welcome to Foundry MCP Server ${VERSION}</h1>
<p>This installer connects MCP clients with Foundry VTT.</p>
<ul>
<li><strong>MCP Server</strong> (required): bridge server and Claude Desktop configuration.</li>
<li><strong>Foundry MCP Bridge</strong> (recommended): Foundry VTT module.</li>
</ul>
<p>Requires Node.js 18 or later and macOS 11 or later.</p>
</body></html>`;

const conclusion = `<!doctype html>
<html><body>
<h1>Installation complete</h1>
<ol>
<li>Restart Claude Desktop.</li>
<li>Launch Foundry VTT and enable Foundry MCP Bridge.</li>
<li>Configure the connection in the module settings.</li>
</ol>
<p><a href="https://github.com/webmaster94/foundry-vtt-mcp">Documentation and support</a></p>
</body></html>`;

for (const [name, contents] of [
  ['welcome.html', welcome],
  ['conclusion.html', conclusion],
  ['license.txt', fs.readFileSync(path.join(ROOT_DIR, 'LICENSE'), 'utf8')],
]) {
  fs.writeFileSync(path.join(BUILD_DIR, name), contents);
}

const distribution = `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>Foundry MCP Server</title>
  <organization>com.foundry-mcp</organization>
  <domains enable_localSystem="true"/>
  <options customize="always" require-scripts="true" hostArchitectures="arm64,x86_64"/>
  <welcome file="welcome.html"/>
  <license file="license.txt"/>
  <conclusion file="conclusion.html"/>
  <choices-outline>
    <line choice="core"/>
    <line choice="foundryModule"/>
  </choices-outline>
  <choice id="core" visible="true" enabled="false" selected="true" title="MCP Server" description="Core Foundry MCP Server and Claude Desktop integration (required)">
    <pkg-ref id="com.foundry-mcp.core"/>
  </choice>
  <choice id="foundryModule" visible="true" enabled="true" start_selected="true" title="Foundry MCP Bridge" description="Foundry VTT bridge module (recommended)">
    <pkg-ref id="com.foundry-mcp.foundry-module"/>
  </choice>
  <pkg-ref id="com.foundry-mcp.core" version="${VERSION}" onConclusion="none">FoundryMCP-Core.pkg</pkg-ref>
  <pkg-ref id="com.foundry-mcp.foundry-module" version="${VERSION}" onConclusion="none">FoundryMCP-FoundryModule.pkg</pkg-ref>
</installer-gui-script>`;

const distributionPath = path.join(BUILD_DIR, 'distribution.xml');
fs.writeFileSync(distributionPath, distribution);
run('productbuild', [
  '--distribution',
  distributionPath,
  '--resources',
  BUILD_DIR,
  '--package-path',
  BUILD_DIR,
  FINAL_PKG,
]);

for (const item of [
  CORE_ROOT,
  FOUNDRY_ROOT,
  coreScripts,
  foundryScripts,
  CORE_PKG,
  FOUNDRY_PKG,
  distributionPath,
  path.join(BUILD_DIR, 'welcome.html'),
  path.join(BUILD_DIR, 'conclusion.html'),
  path.join(BUILD_DIR, 'license.txt'),
]) {
  fs.rmSync(item, { recursive: true, force: true });
}

console.log(`Created ${FINAL_PKG} (${(fs.statSync(FINAL_PKG).size / 1024 / 1024).toFixed(1)} MB)`);
