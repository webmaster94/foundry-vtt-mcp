#!/usr/bin/env node
/**
 * One-command setup for the Foundry MCP server.
 *
 *   npm run setup                # detect and configure every installed client
 *   npm run setup -- --clients claude-desktop,claude-code,codex
 *   npm run setup -- --list      # show what would be configured, change nothing
 *
 * What it does:
 *   1. Builds the server if packages/mcp-server/dist/index.js is missing.
 *   2. Registers the server with each AI client it can find:
 *      - Claude Desktop  (claude_desktop_config.json)
 *      - Claude Code     (`claude mcp add`, user scope)
 *      - Codex CLI       (`codex mcp add`, or ~/.codex/config.toml)
 *   3. Prints what changed and what to do next.
 *
 * Safe to re-run: existing foundry-mcp entries are updated in place.
 * JSON configs are backed up to <file>.bak before writing.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(repoRoot, 'packages', 'mcp-server', 'dist', 'index.js');
const SERVER_NAME = 'foundry-mcp';

const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');
const clientsArgIdx = argv.indexOf('--clients');
const onlyClients =
  clientsArgIdx > -1 && argv[clientsArgIdx + 1]
    ? argv[clientsArgIdx + 1].split(',').map(s => s.trim())
    : null;

const results = [];
const note = (client, status, detail) => {
  results.push({ client, status, detail });
  const icon = { configured: 'OK ', updated: 'OK ', skipped: '-- ', manual: '!! ', error: 'ERR' }[status];
  console.log(`  ${icon} ${client}: ${detail}`);
};

function run(command, args, opts = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32', // resolve npm/claude/codex shims on Windows
    ...opts,
  });
}

function commandExists(command) {
  const probe = run(command, ['--version']);
  return probe.status === 0;
}

function backupAndWriteJson(file, data) {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------- build
console.log('Foundry MCP server setup');
console.log('========================');
console.log(`Server entry: ${serverEntry}`);

if (!fs.existsSync(serverEntry)) {
  if (listOnly) {
    console.log('  (not built yet — setup would run "npm run build")');
  } else {
    console.log('\nBuilding the server (first run)...');
    const build = run('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
    if (build.status !== 0) {
      console.error('\nBuild failed. Run "npm install" first, then re-run "npm run setup".');
      process.exit(1);
    }
    if (!fs.existsSync(serverEntry)) {
      console.error(`\nBuild finished but ${serverEntry} is still missing — aborting.`);
      process.exit(1);
    }
  }
}

// Multi-server profiles: if the repo has a foundry-servers.json, point every
// client registration at it so all clients see the same named servers.
const serversFile = path.join(repoRoot, 'foundry-servers.json');
const serverEnv = fs.existsSync(serversFile) ? { FOUNDRY_SERVERS_CONFIG: serversFile } : null;
if (serverEnv) console.log(`Servers config: ${serversFile} (will be passed to all clients)`);

const serverConfig = { command: 'node', args: [serverEntry], ...(serverEnv ? { env: serverEnv } : {}) };
const wants = client => !onlyClients || onlyClients.includes(client);
console.log('\nConfiguring AI clients:');

// ---------------------------------------------------------------- Claude Desktop
if (wants('claude-desktop')) {
  const candidates =
    process.platform === 'win32'
      ? [path.join(process.env.APPDATA || '', 'Claude')]
      : process.platform === 'darwin'
        ? [path.join(os.homedir(), 'Library', 'Application Support', 'Claude')]
        : [path.join(os.homedir(), '.config', 'Claude')];
  const dir = candidates.find(candidate => candidate && fs.existsSync(candidate));

  if (!dir) {
    note('claude-desktop', 'skipped', 'Claude Desktop not found');
  } else if (listOnly) {
    note('claude-desktop', 'configured', `would update ${path.join(dir, 'claude_desktop_config.json')}`);
  } else {
    try {
      const file = path.join(dir, 'claude_desktop_config.json');
      let config = {};
      if (fs.existsSync(file)) {
        try {
          config = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          note('claude-desktop', 'error', `${file} is not valid JSON — fix or delete it, then re-run`);
          config = null;
        }
      }
      if (config) {
        config.mcpServers = config.mcpServers || {};
        const existed = !!config.mcpServers[SERVER_NAME];
        config.mcpServers[SERVER_NAME] = { ...config.mcpServers[SERVER_NAME], ...serverConfig };
        backupAndWriteJson(file, config);
        note('claude-desktop', existed ? 'updated' : 'configured', `${file} (restart Claude Desktop)`);
      }
    } catch (error) {
      note('claude-desktop', 'error', error.message);
    }
  }
}

// ---------------------------------------------------------------- Claude Code
if (wants('claude-code')) {
  if (!commandExists('claude')) {
    note('claude-code', 'skipped', 'claude CLI not found');
  } else if (listOnly) {
    note('claude-code', 'configured', 'would run: claude mcp add (user scope)');
  } else {
    run('claude', ['mcp', 'remove', SERVER_NAME, '--scope', 'user']); // ignore failures: may not exist
    const envFlags = serverEnv
      ? Object.entries(serverEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`])
      : [];
    const add = run('claude', ['mcp', 'add', SERVER_NAME, '--scope', 'user', ...envFlags, '--', 'node', serverEntry]);
    if (add.status === 0) {
      note('claude-code', 'configured', 'registered at user scope (available in every project)');
    } else {
      note('claude-code', 'error', (add.stderr || add.stdout || 'claude mcp add failed').trim().split('\n')[0]);
    }
  }
}

// ---------------------------------------------------------------- Codex CLI
if (wants('codex')) {
  const codexDir = path.join(os.homedir(), '.codex');
  const hasCli = commandExists('codex');
  if (!hasCli && !fs.existsSync(codexDir)) {
    note('codex', 'skipped', 'Codex CLI not found');
  } else if (listOnly) {
    note('codex', 'configured', hasCli ? 'would run: codex mcp add' : `would update ${path.join(codexDir, 'config.toml')}`);
  } else if (hasCli) {
    run('codex', ['mcp', 'remove', SERVER_NAME]); // ignore failures: may not exist
    const codexEnvFlags = serverEnv
      ? Object.entries(serverEnv).flatMap(([key, value]) => ['--env', `${key}=${value}`])
      : [];
    const add = run('codex', ['mcp', 'add', SERVER_NAME, ...codexEnvFlags, '--', 'node', serverEntry]);
    if (add.status === 0) {
      note('codex', 'configured', 'registered via codex mcp add');
    } else {
      configureCodexToml(codexDir); // older CLIs lack `codex mcp` — fall back to config.toml
    }
  } else {
    configureCodexToml(codexDir);
  }
}

function configureCodexToml(codexDir) {
  try {
    const file = path.join(codexDir, 'config.toml');
    const escaped = serverEntry.replace(/\\/g, '\\\\');
    const envLine = serverEnv
      ? `env = { ${Object.entries(serverEnv)
          .map(([key, value]) => `${key} = "${value.replace(/\\/g, '\\\\')}"`)
          .join(', ')} }\n`
      : '';
    const section = `\n[mcp_servers.${SERVER_NAME}]\ncommand = "node"\nargs = ["${escaped}"]\n${envLine}`;
    let contents = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const marker = `[mcp_servers.${SERVER_NAME}]`;
    if (contents.includes(marker)) {
      // Replace the existing section (up to the next table header or EOF)
      const start = contents.indexOf(marker);
      let end = contents.length;
      const rest = contents.slice(start + marker.length);
      const next = rest.search(/\n\[/);
      if (next !== -1) end = start + marker.length + next;
      contents = contents.slice(0, start).replace(/\n+$/, '\n') + section.trimStart() + contents.slice(end);
      fs.copyFileSync(file, `${file}.bak`);
      fs.writeFileSync(file, contents, 'utf8');
      note('codex', 'updated', `${file} (section replaced)`);
    } else {
      fs.mkdirSync(codexDir, { recursive: true });
      if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
      fs.appendFileSync(file, section, 'utf8');
      note('codex', 'configured', file);
    }
  } catch (error) {
    note('codex', 'error', error.message);
  }
}

// ---------------------------------------------------------------- summary
const configured = results.filter(r => r.status === 'configured' || r.status === 'updated');
console.log('\n========================');
if (listOnly) {
  console.log('List mode: nothing was changed.');
} else if (configured.length) {
  console.log(`Done — ${configured.map(r => r.client).join(', ')} configured.`);
  console.log('\nNext steps:');
  console.log('  1. Install the Foundry module (Install Module -> paste manifest URL):');
  console.log('     https://github.com/webmaster94/foundry-vtt-mcp/releases/latest/download/module.json');
  console.log('  2. Enable "Foundry MCP Bridge" in your world and launch it.');
  console.log('  3. Restart your AI client — the foundry-mcp tools appear automatically.');
} else {
  console.log('No AI clients were configured. Install Claude Desktop, Claude Code, or Codex CLI');
  console.log('and re-run "npm run setup", or configure manually (see README).');
}
const failed = results.filter(r => r.status === 'error');
process.exit(failed.length ? 1 : 0);
