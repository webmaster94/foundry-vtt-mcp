#!/usr/bin/env node

/**
 * Exercise the compiled NSIS package on an ephemeral GitHub-hosted Windows runner.
 *
 * This is intentionally stricter than a normal test fixture because NSIS resolves
 * HKCU, AppData, and Start Menu locations through Windows rather than process-local
 * environment overrides. The test refuses to run unless the runner has no existing
 * bridge, supported-client configuration, Foundry data directory, or control listener.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
).version;
const productId = 'io.github.webmaster94.foundry-vtt-mcp';
const productName = 'Foundry VTT MCP Bridge';
const productExe = 'FoundryVTT MCP Bridge.exe';
const uninstallKey =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\FoundryMCPServer';
const uninstallProviderPath =
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\FoundryMCPServer';
const controlPort = 31414;

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  let installer = process.env.FOUNDRY_MCP_LIFECYCLE_INSTALLER ?? null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--installer') {
      installer = argv[++index] ?? null;
    } else {
      fail(`Unknown argument: ${argv[index]}`);
    }
  }
  if (!installer) fail('--installer or FOUNDRY_MCP_LIFECYCLE_INSTALLER is required');
  return { installer: path.resolve(installer) };
}

function sameWindowsPath(left, right) {
  return (
    path
      .resolve(left)
      .replace(/[\\/]+$/, '')
      .toLowerCase() ===
    path
      .resolve(right)
      .replace(/[\\/]+$/, '')
      .toLowerCase()
  );
}

function isWithin(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function commandResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout ?? 120_000,
    env: options.env ?? process.env,
  });
  if (result.error) throw result.error;
  return result;
}

function runChecked(command, args, options = {}) {
  const result = commandResult(command, args, options);
  if (result.status !== 0) {
    fail(
      `${path.basename(command)} exited with ${result.status}: ${(result.stdout ?? '').slice(-4000)}${(
        result.stderr ?? ''
      ).slice(-4000)}`
    );
  }
  return result;
}

function registryExists() {
  return commandResult('reg.exe', ['query', uninstallKey], { timeout: 10_000 }).status === 0;
}

function readUninstallRegistration() {
  const script = String.raw`
$value = Get-ItemProperty -LiteralPath $env:FOUNDRY_MCP_TEST_REGISTRY -ErrorAction Stop
[ordered]@{
  DisplayName = [string]$value.DisplayName
  DisplayVersion = [string]$value.DisplayVersion
  InstallLocation = [string]$value.InstallLocation
  DisplayIcon = [string]$value.DisplayIcon
  Publisher = [string]$value.Publisher
  UninstallString = [string]$value.UninstallString
  QuietUninstallString = [string]$value.QuietUninstallString
  EstimatedSize = [int64]$value.EstimatedSize
  NoModify = [int]$value.NoModify
  NoRepair = [int]$value.NoRepair
} | ConvertTo-Json -Compress
`;
  const result = runChecked(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      timeout: 20_000,
      env: { ...process.env, FOUNDRY_MCP_TEST_REGISTRY: uninstallProviderPath },
    }
  );
  return JSON.parse(result.stdout.trim());
}

function resolveShortcut(shortcutPath) {
  const script = String.raw`
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($env:FOUNDRY_MCP_TEST_SHORTCUT)
[ordered]@{ TargetPath = [string]$shortcut.TargetPath; Arguments = [string]$shortcut.Arguments } |
  ConvertTo-Json -Compress
`;
  const result = runChecked(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      timeout: 20_000,
      env: { ...process.env, FOUNDRY_MCP_TEST_SHORTCUT: shortcutPath },
    }
  );
  return JSON.parse(result.stdout.trim());
}

function assertOrdinaryFile(file, label = file) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${label} is not an ordinary file`);
}

function assertAbsent(target, label = target) {
  assert.ok(
    !fs.existsSync(target),
    `${label} already exists; refusing a non-isolated lifecycle test`
  );
}

function assertNoReparseTree(root) {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  assert.ok(!stat.isSymbolicLink(), `Refusing to clean linked test path: ${root}`);
  if (!stat.isDirectory()) return;
  for (const name of fs.readdirSync(root)) assertNoReparseTree(path.join(root, name));
}

function removeTestTree(root) {
  if (!fs.existsSync(root)) return;
  assertNoReparseTree(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a Foundry fixture port')));
        return;
      }
      const port = address.port;
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

async function portIsFree(port) {
  return await new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function controlRequest(method, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const id = `packaged-lifecycle-${method}-${Date.now()}`;
    const socket = net.createConnection({ host: '127.0.0.1', port: controlPort });
    let buffer = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Control request ${method} timed out`));
    }, timeoutMs);
    const finish = callback => {
      clearTimeout(timeout);
      socket.destroy();
      callback();
    };
    socket.setEncoding('utf8');
    socket.once('error', error => finish(() => reject(error)));
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.id !== id || response.error || response.result === undefined) {
          throw new Error(`Invalid control response for ${method}`);
        }
        finish(() => resolve(response.result));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id, method, params: {} })}\n`);
    });
  });
}

async function waitFor(description, predicate, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`
  );
}

function waitForChildExit(child, timeoutMs = 30_000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`PID ${child.pid} did not exit`)), timeoutMs);
    child.once('exit', code => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

function verifyPayload(installDir) {
  const required = [
    productExe,
    'Uninstall.exe',
    'foundry-vtt-mcp-bridge.install-id',
    'installer-owned-files.json',
    'runtime\\node.exe',
    'resources\\app.asar',
    'resources\\server\\index.bundle.cjs',
    'resources\\server\\backend.bundle.cjs',
    'resources\\installer\\stop-bridge.ps1',
  ];
  for (const relative of required) assertOrdinaryFile(path.join(installDir, relative), relative);
  assert.equal(
    fs.readFileSync(path.join(installDir, 'foundry-vtt-mcp-bridge.install-id'), 'utf8').trim(),
    productId
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(installDir, 'installer-owned-files.json'), 'utf8')
  );
  assert.equal(manifest.productId, productId);
  assert.equal(manifest.version, packageVersion);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 20);
  for (const relative of manifest.files) {
    assertOrdinaryFile(path.join(installDir, ...relative.split('\\')), `manifest: ${relative}`);
  }
}

function verifyRegistrationAndShortcuts(installDir, startMenuDir) {
  const registration = readUninstallRegistration();
  const executable = path.join(installDir, productExe);
  const uninstaller = path.join(installDir, 'Uninstall.exe');
  assert.equal(registration.DisplayName, productName);
  assert.equal(registration.DisplayVersion, packageVersion);
  assert.ok(sameWindowsPath(registration.InstallLocation, installDir));
  assert.equal(registration.Publisher, 'webmaster94');
  assert.equal(registration.UninstallString, `"${uninstaller}"`);
  assert.equal(registration.QuietUninstallString, `"${uninstaller}" /S`);
  assert.equal(registration.DisplayIcon, `"${executable}",0`);
  assert.ok(registration.EstimatedSize > 0);
  assert.equal(registration.NoModify, 1);
  assert.equal(registration.NoRepair, 1);

  const applicationShortcut = path.join(startMenuDir, `${productName}.lnk`);
  const uninstallShortcut = path.join(startMenuDir, `Uninstall ${productName}.lnk`);
  assertOrdinaryFile(applicationShortcut, 'application Start Menu shortcut');
  assertOrdinaryFile(uninstallShortcut, 'uninstall Start Menu shortcut');
  assert.ok(sameWindowsPath(resolveShortcut(applicationShortcut).TargetPath, executable));
  assert.ok(sameWindowsPath(resolveShortcut(uninstallShortcut).TargetPath, uninstaller));
}

function runInstaller(installer, installDir, environment) {
  // NSIS requires /D to be the final argument and accepts the path, including
  // spaces, as one unquoted argv value.
  runChecked(installer, ['/S', `/D=${installDir}`], { timeout: 180_000, env: environment });
}

function verifyForeignCodexConfig(configPath, expectedBytes) {
  assert.deepEqual(
    fs.readFileSync(configPath),
    expectedBytes,
    'silent setup or uninstall changed the foreign same-name Codex registration'
  );
  assert.equal(
    fs
      .readdirSync(path.dirname(configPath))
      .filter(name => name.startsWith(`${path.basename(configPath)}.backup-`)).length,
    0,
    'refused foreign Codex registration created a backup'
  );
}

async function stopTestApplication(executable, environment) {
  if (!fs.existsSync(executable)) return;
  const result = commandResult(executable, ['--shutdown-for-update'], {
    timeout: 30_000,
    env: environment,
  });
  if (result.status !== 0 && result.status !== null) {
    throw new Error(`Packaged shutdown request exited with ${result.status}`);
  }
  await waitFor('packaged backend shutdown', async () => {
    try {
      await controlRequest('ping', 500);
      return false;
    } catch {
      return true;
    }
  });
}

async function main() {
  if (
    process.platform !== 'win32' ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_OS !== 'Windows' ||
    process.env.FOUNDRY_MCP_ALLOW_PACKAGED_LIFECYCLE_TEST !== '1'
  ) {
    fail(
      'Packaged lifecycle testing is restricted to an explicitly opted-in GitHub Actions Windows runner'
    );
  }

  const { installer } = parseArguments(process.argv.slice(2));
  const installerBuildRoot = path.join(repoRoot, 'installer', 'build');
  if (!isWithin(installer, installerBuildRoot)) {
    fail(`Installer must be below the repository build directory: ${installer}`);
  }
  assertOrdinaryFile(installer, 'compiled NSIS installer');

  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  if (!appData || !localAppData || !userProfile) fail('Windows user profile paths are unavailable');

  const canonicalRoot = path.join(appData, 'FoundryVTT MCP Bridge');
  const canonicalConfig = path.join(canonicalRoot, 'foundry-servers.json');
  const claudeRoot = path.join(appData, 'Claude');
  const claudeCodeConfig = path.join(userProfile, '.claude.json');
  const codexConfig = path.join(userProfile, '.codex', 'config.toml');
  const startMenuDir = path.join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    productName
  );
  const legacyInstall = path.join(localAppData, 'FoundryMCPServer');
  const currentDefaultInstall = path.join(localAppData, 'Programs', productName);
  const foundryModuleCandidates = [
    path.join(localAppData, 'FoundryVTT_Next', 'Data', 'modules'),
    path.join(appData, 'FoundryVTT_Next', 'Data', 'modules'),
    path.join(localAppData, 'FoundryVTT', 'Data', 'modules'),
    path.join(appData, 'FoundryVTT', 'Data', 'modules'),
  ];

  if (registryExists()) fail('An existing Programs & Features registration is present');
  for (const [target, label] of [
    [canonicalRoot, 'canonical bridge settings'],
    [claudeRoot, 'Claude Desktop settings'],
    [claudeCodeConfig, 'Claude Code settings'],
    [codexConfig, 'Codex settings'],
    [startMenuDir, 'bridge Start Menu folder'],
    [legacyInstall, 'legacy bridge installation'],
    [currentDefaultInstall, 'default desktop bridge installation'],
  ]) {
    assertAbsent(target, label);
  }
  for (const candidate of foundryModuleCandidates) assertAbsent(candidate, 'Foundry modules path');
  if (process.env.FOUNDRY_VTT_DATA_PATH || process.env.FOUNDRY_SERVERS_CONFIG) {
    fail('Foundry path overrides are present; refusing a non-isolated lifecycle test');
  }
  const packagesRoot = path.join(localAppData, 'Packages');
  if (
    fs.existsSync(packagesRoot) &&
    fs
      .readdirSync(packagesRoot, { withFileTypes: true })
      .some(entry => entry.isDirectory() && entry.name.toLowerCase().includes('claude'))
  ) {
    fail('A Claude MSIX profile is present; refusing a non-isolated lifecycle test');
  }
  if (!(await portIsFree(controlPort))) fail(`Control port ${controlPort} is already in use`);

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-mcp-packaged-lifecycle-'));
  const installDir = path.join(fixtureRoot, 'Install With Spaces', productName);
  const isolatedUserProfile = path.join(fixtureRoot, 'Isolated User Profile');
  const foreignCodexConfig = path.join(isolatedUserProfile, '.codex', 'config.toml');
  const foreignCodexBytes = Buffer.from(
    `[mcp_servers.foundry-mcp]\r\n` +
      `command = "C:\\\\Unrelated\\\\node.exe"\r\n` +
      `args = ["C:\\\\Unrelated\\\\server.cjs", "--foreign"]\r\n`,
    'utf8'
  );
  const foundryPort = await freePort();
  const configBytes = Buffer.from(
    `${JSON.stringify(
      {
        defaultServer: 'lifecycle',
        servers: {
          lifecycle: {
            label: 'Packaged lifecycle fixture',
            host: '127.0.0.1',
            port: foundryPort,
            connectionType: 'websocket',
            remoteMode: false,
          },
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  const environment = {
    ...process.env,
    USERPROFILE: isolatedUserProfile,
    HOME: isolatedUserProfile,
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  let application = null;
  let applicationLaunchError = null;
  let installedClaudeHelper = null;
  let heldClaudeHelper = null;

  try {
    fs.mkdirSync(canonicalRoot, { recursive: true });
    fs.writeFileSync(canonicalConfig, configBytes, { flag: 'wx' });
    fs.mkdirSync(path.dirname(foreignCodexConfig), { recursive: true });
    fs.writeFileSync(foreignCodexConfig, foreignCodexBytes, { flag: 'wx' });

    runInstaller(installer, installDir, environment);
    verifyPayload(installDir);
    verifyRegistrationAndShortcuts(installDir, startMenuDir);
    assert.deepEqual(fs.readFileSync(canonicalConfig), configBytes);
    verifyForeignCodexConfig(foreignCodexConfig, foreignCodexBytes);

    const executable = path.join(installDir, productExe);
    application = spawn(executable, [], {
      env: environment,
      stdio: 'ignore',
      windowsHide: true,
    });
    application.once('error', error => {
      applicationLaunchError = error;
      process.stderr.write(`Packaged application launch failed: ${error.message}\n`);
    });

    const ping = await waitFor('packaged backend control channel', async () => {
      if (applicationLaunchError) throw applicationLaunchError;
      if (application.exitCode !== null) {
        throw new Error(`Packaged application exited early with ${application.exitCode}`);
      }
      return await controlRequest('ping');
    });
    assert.ok(
      sameWindowsPath(
        ping.entryPath,
        path.join(installDir, 'resources', 'server', 'backend.bundle.cjs')
      ),
      `Packaged backend reported an unexpected entry path: ${ping.entryPath}`
    );
    const status = await controlRequest('get_status');
    assert.ok(sameWindowsPath(status.config.path, canonicalConfig));

    await stopTestApplication(executable, environment);
    assert.equal(await waitForChildExit(application), 0);
    application = null;

    const upgradeSentinel = path.join(installDir, 'lifecycle-upgrade-sentinel.txt');
    fs.writeFileSync(upgradeSentinel, 'preserve across in-place upgrade\n', { flag: 'wx' });
    runInstaller(installer, installDir, environment);
    verifyPayload(installDir);
    verifyRegistrationAndShortcuts(installDir, startMenuDir);
    assert.equal(fs.readFileSync(upgradeSentinel, 'utf8'), 'preserve across in-place upgrade\n');
    assert.deepEqual(fs.readFileSync(canonicalConfig), configBytes);
    verifyForeignCodexConfig(foreignCodexConfig, foreignCodexBytes);
    fs.rmSync(upgradeSentinel);

    const uninstaller = path.join(installDir, 'Uninstall.exe');
    installedClaudeHelper = path.join(installDir, 'resources', 'installer', 'configure-claude.ps1');
    heldClaudeHelper = `${installedClaudeHelper}.lifecycle-hold`;
    fs.renameSync(installedClaudeHelper, heldClaudeHelper);
    const blockedUninstall = commandResult(uninstaller, ['/S'], {
      timeout: 60_000,
      env: environment,
    });
    assert.equal(
      blockedUninstall.status,
      2,
      `silent uninstall did not fail safely after MCP-client cleanup failed: ${blockedUninstall.stdout}${blockedUninstall.stderr}`
    );
    fs.renameSync(heldClaudeHelper, installedClaudeHelper);
    heldClaudeHelper = null;
    assert.ok(registryExists(), 'failed MCP-client cleanup removed Programs & Features metadata');
    verifyPayload(installDir);
    verifyRegistrationAndShortcuts(installDir, startMenuDir);
    assert.deepEqual(
      fs.readFileSync(canonicalConfig),
      configBytes,
      'failed MCP-client cleanup changed canonical server configuration'
    );
    verifyForeignCodexConfig(foreignCodexConfig, foreignCodexBytes);

    runChecked(uninstaller, ['/S'], {
      timeout: 180_000,
      env: environment,
    });
    assert.ok(!registryExists(), 'Programs & Features registration survived uninstall');
    assertAbsent(startMenuDir, 'bridge Start Menu folder after uninstall');
    assertAbsent(installDir, 'program directory after uninstall');
    assert.deepEqual(
      fs.readFileSync(canonicalConfig),
      configBytes,
      'canonical server configuration was not preserved byte-for-byte'
    );
    verifyForeignCodexConfig(foreignCodexConfig, foreignCodexBytes);
    process.stdout.write(
      '[windows-packaged-lifecycle] PASS: silent foreign-Codex install/upgrade, packaged launch, cleanup-failure retention, P&F, shortcuts, uninstall, and user-config preservation\n'
    );
  } finally {
    if (
      installedClaudeHelper &&
      heldClaudeHelper &&
      fs.existsSync(heldClaudeHelper) &&
      !fs.existsSync(installedClaudeHelper)
    ) {
      fs.renameSync(heldClaudeHelper, installedClaudeHelper);
      heldClaudeHelper = null;
    }
    if (application?.exitCode === null) {
      try {
        await stopTestApplication(path.join(installDir, productExe), environment);
      } catch {
        application.kill();
      }
      await waitForChildExit(application, 10_000).catch(() => undefined);
    }
    try {
      const ping = await controlRequest('ping', 500);
      if (
        ping.entryPath &&
        isWithin(path.resolve(ping.entryPath), path.join(installDir, 'resources', 'server'))
      ) {
        await controlRequest('shutdown', 2_000).catch(() => undefined);
      }
    } catch {
      // No test-owned backend remains.
    }
    if (fs.existsSync(path.join(installDir, 'Uninstall.exe'))) {
      commandResult(path.join(installDir, 'Uninstall.exe'), ['/S'], {
        timeout: 120_000,
        env: environment,
      });
    }
    if (registryExists()) {
      try {
        const registration = readUninstallRegistration();
        if (sameWindowsPath(registration.InstallLocation, installDir)) {
          commandResult('reg.exe', ['delete', uninstallKey, '/f'], { timeout: 10_000 });
        }
      } catch {
        // Never delete an unverifiable registration.
      }
    }
    removeTestTree(startMenuDir);
    removeTestTree(claudeRoot);
    removeTestTree(canonicalRoot);
    removeTestTree(fixtureRoot);
  }
}

await main();
