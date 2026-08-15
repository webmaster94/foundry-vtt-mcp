#!/usr/bin/env node

/**
 * Mac DMG Builder - Professional Distribution Package
 *
 * Creates a DMG disk image containing:
 * - FoundryMCPServer-{VERSION}-macOS.pkg (installer)
 * - Uninstall.tool (double-clickable uninstaller)
 * - README.txt (installation instructions)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const VERSION = process.env.VERSION || require('../package.json').version;

// Paths
const BUILD_DIR = path.join(__dirname, 'build');
const DMG_TEMP = path.join(BUILD_DIR, 'dmg-temp');
const PKG_FILE = path.join(BUILD_DIR, `FoundryMCPServer-${VERSION}-macOS.pkg`);
const UNINSTALL_TOOL = path.join(__dirname, 'Uninstall.tool');
const DMG_OUTPUT = path.join(BUILD_DIR, `FoundryMCPServer-${VERSION}.dmg`);

console.log('💿 Building Professional Mac DMG Distribution');
console.log(`Version: ${VERSION}`);
console.log('');

// Check if PKG exists
if (!fs.existsSync(PKG_FILE)) {
  console.error('❌ PKG file not found. Run: node build-mac-pkg.js first');
  console.error(`   Expected: ${PKG_FILE}`);
  process.exit(1);
}

// Check if Uninstall.tool exists
if (!fs.existsSync(UNINSTALL_TOOL)) {
  console.error('❌ Uninstall.tool not found');
  console.error(`   Expected: ${UNINSTALL_TOOL}`);
  process.exit(1);
}

// Clean and create DMG temp directory
console.log('📁 Preparing DMG contents...');
if (fs.existsSync(DMG_TEMP)) {
  fs.rmSync(DMG_TEMP, { recursive: true, force: true });
}
fs.mkdirSync(DMG_TEMP, { recursive: true });

// Copy PKG to temp directory
console.log('   • Copying installer PKG...');
fs.copyFileSync(PKG_FILE, path.join(DMG_TEMP, path.basename(PKG_FILE)));

// Copy Uninstall.tool to temp directory
console.log('   • Copying Uninstall.tool...');
fs.copyFileSync(UNINSTALL_TOOL, path.join(DMG_TEMP, 'Uninstall.tool'));
// Ensure it's executable
fs.chmodSync(path.join(DMG_TEMP, 'Uninstall.tool'), 0o755);

// Create README.txt
console.log('   • Creating README.txt...');
const readme = `Foundry MCP Server ${VERSION}
═══════════════════════════════════════════════════════════════

MCP-powered campaign management for Foundry VTT

📦 INSTALLATION
═══════════════════════════════════════════════════════════════

1. Double-click "FoundryMCPServer-${VERSION}-macOS.pkg"
2. Follow the installer prompts
3. Choose components:
   ✅ MCP Server (Required)
   ✅ Foundry Module (Optional, recommended)
4. Restart Claude Desktop
5. Start using your MCP client with Foundry VTT!

The installer will automatically configure Claude Desktop to connect
to the MCP server.

🗑️  UNINSTALLATION
═══════════════════════════════════════════════════════════════

Double-click "Uninstall.tool" to completely remove all components.

This will remove:
• MCP Server from /Applications
• Claude Desktop configuration
• Foundry VTT module
• Bridge-owned cache and log files

User-created Foundry content and generated maps are preserved. Only the
retired per-world Enhanced Creature Index cache is removed.

⚠️  Note: Uninstallation cannot be undone!

📋 SYSTEM REQUIREMENTS
═══════════════════════════════════════════════════════════════

• macOS 11.0 (Big Sur) or later
• Apple Silicon (M1/M2/M3/M4) or Intel Mac
• Claude Desktop application
• Foundry VTT v13 or v14

🚀 QUICK START
═══════════════════════════════════════════════════════════════

After installation:

1. Open Claude Desktop (it will auto-connect to MCP server)
2. Open Foundry VTT and enable "MCP Bridge" module
3. In Claude, try: "Create a level 5 elven wizard named Elara"
4. In Claude, try: "Create a quest to find the lost amulet"
5. In Claude, try: "Show me the actors in the current scene"

📚 FEATURES
═══════════════════════════════════════════════════════════════

• Generic Foundry document management with dry-run, audit, and undo
• Actor creation with natural language processing
• Quest management with HTML generation
• Campaign system with multi-part adventures
• Dice roll coordination between Claude and Foundry
• WebSocket and WebRTC bridge connections
• Actor ownership and permission management
• Bounded compendium search over live Foundry data

📖 DOCUMENTATION
═══════════════════════════════════════════════════════════════

Full documentation: https://github.com/webmaster94/foundry-vtt-mcp

Need help? Report issues at:
https://github.com/webmaster94/foundry-vtt-mcp/issues

═══════════════════════════════════════════════════════════════
© 2025 Foundry MCP Server
Licensed under MIT License
`;

fs.writeFileSync(path.join(DMG_TEMP, 'README.txt'), readme, 'utf8');
console.log('   ✅ DMG contents prepared');

// Remove existing DMG if it exists
if (fs.existsSync(DMG_OUTPUT)) {
  console.log('\n🗑️  Removing existing DMG...');
  fs.unlinkSync(DMG_OUTPUT);
}

// Create DMG using hdiutil
console.log('\n💿 Creating DMG disk image...');
console.log(`   Source: ${DMG_TEMP}`);
console.log(`   Output: ${DMG_OUTPUT}`);

try {
  // Create DMG with better compression and settings
  execSync(
    `hdiutil create -volname "Foundry MCP Server ${VERSION}" ` +
      `-srcfolder "${DMG_TEMP}" ` +
      `-ov -format UDZO ` +
      `-fs HFS+ ` +
      `"${DMG_OUTPUT}"`,
    { stdio: 'inherit' }
  );

  console.log('   ✅ DMG created successfully');
} catch (error) {
  console.error('❌ Failed to create DMG:', error.message);
  process.exit(1);
}

// Clean up temp directory
console.log('\n🧹 Cleaning up...');
fs.rmSync(DMG_TEMP, { recursive: true, force: true });
console.log('   ✅ Temporary files removed');

// Get file size
const stats = fs.statSync(DMG_OUTPUT);
const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('✅ DMG Build Complete!');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');
console.log(`📦 File: ${DMG_OUTPUT}`);
console.log(`📊 Size: ${sizeMB} MB`);
console.log('');
console.log('Contents:');
console.log(`  • FoundryMCPServer-${VERSION}-macOS.pkg (installer)`);
console.log('  • Uninstall.tool (double-click to uninstall)');
console.log('  • README.txt (installation instructions)');
console.log('');
console.log('Distribution ready for release! 🎉');
console.log('');
