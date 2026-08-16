#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const installerDir = path.resolve(testDir, '..');
const nsisDir = path.join(installerDir, 'nsis');
const nsisPath = path.join(nsisDir, 'foundry-mcp-server.nsi');
const migrationPath = path.join(nsisDir, 'install-migration.ps1');
const configurePath = path.join(nsisDir, 'configure-claude.ps1');
const configureCodexPath = path.join(nsisDir, 'configure-codex.mjs');
const moduleCleanupPath = path.join(nsisDir, 'foundry-module-cleanup.ps1');
const stopPath = path.join(nsisDir, 'stop-bridge.ps1');
const buildPath = path.join(installerDir, 'build-nsis.js');
const repoRoot = path.resolve(installerDir, '..');
const releaseWorkflowPath = path.join(
  repoRoot,
  '.github',
  'workflows',
  'build-complete-release.yml'
);
const rootPackagePath = path.join(repoRoot, 'package.json');
const desktopMainPath = path.join(repoRoot, 'packages', 'desktop', 'src', 'main', 'main.ts');
const productId = 'io.github.webmaster94.foundry-vtt-mcp';

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function assertIncludes(contents, needle, label = needle) {
  assert.ok(contents.includes(needle), `missing ${label}`);
}

function assertBefore(contents, guard, mutation) {
  const guardIndex = contents.indexOf(guard);
  const mutationIndex = contents.indexOf(mutation);
  assert.notEqual(guardIndex, -1, `missing guard: ${guard}`);
  assert.notEqual(mutationIndex, -1, `missing mutation: ${mutation}`);
  assert.ok(guardIndex < mutationIndex, `${guard} must precede ${mutation}`);
}

function canonicalPathForComparison(value) {
  let existing = path.resolve(value);
  const missingSegments = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missingSegments.unshift(path.basename(existing));
    existing = parent;
  }
  const canonicalBase = fs.existsSync(existing) ? fs.realpathSync.native(existing) : existing;
  const canonical = path.join(canonicalBase, ...missingSegments);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function assertSamePath(actual, expected, message) {
  assert.equal(canonicalPathForComparison(actual), canonicalPathForComparison(expected), message);
}

function runStaticChecks() {
  const nsis = read(nsisPath);
  const migration = read(migrationPath);
  const configure = read(configurePath);
  const configureCodex = read(configureCodexPath);
  const moduleCleanup = read(moduleCleanupPath);
  const stop = read(stopPath);
  const build = read(buildPath);
  const releaseWorkflow = read(releaseWorkflowPath);
  const rootPackage = JSON.parse(read(rootPackagePath));
  const desktopMain = read(desktopMainPath);

  for (const required of [
    'Name "${PRODUCT_NAME}"',
    '!define PRODUCT_NAME "Foundry VTT MCP Bridge"',
    '!define PRODUCT_EXE "FoundryVTT MCP Bridge.exe"',
    'InstallDir "$LOCALAPPDATA\\Programs\\Foundry VTT MCP Bridge"',
    'InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"',
    'StrCpy $INSTDIR "$LOCALAPPDATA\\Programs\\Foundry VTT MCP Bridge"',
    'File /r "${STAGE_DIR}\\payload\\*"',
    'CreateShortcut "$SMPROGRAMS\\${START_MENU_FOLDER}\\${PRODUCT_NAME}.lnk"',
    'CreateShortcut "$SMPROGRAMS\\${START_MENU_FOLDER}\\Uninstall ${PRODUCT_NAME}.lnk"',
    'WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT_NAME}"',
    'WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" "$\\"$INSTDIR\\Uninstall.exe$\\""',
    'WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" "$\\"$INSTDIR\\Uninstall.exe$\\" /S"',
    'WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"',
    'WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$\\"$INSTDIR\\${PRODUCT_EXE}$\\",0"',
    'WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"',
    'WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"',
    'WriteRegStr HKCU "${UNINSTALL_KEY}" "URLInfoAbout" "${PRODUCT_URL}"',
    'WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" ${ESTIMATED_SIZE_KB}',
    '!define MUI_FINISHPAGE_RUN "$INSTDIR\\${PRODUCT_EXE}"',
  ]) {
    assertIncludes(nsis, required);
  }

  assertBefore(nsis, 'Call StopPreviousBridge', 'File /r "${STAGE_DIR}\\payload\\*"');
  assert.equal(
    (nsis.match(/Call StopPreviousBridge/g) || []).length,
    1,
    'setup must not stop the running bridge before the user starts installation'
  );
  assertBefore(nsis, 'Call RunMigrationPrepare', 'File /r "${STAGE_DIR}\\payload\\*"');
  assertBefore(nsis, 'Call un.StopInstalledBridge', 'Call un.RemoveOwnedPayload');
  const messageBoxes = nsis.split(/\r?\n/).filter(line => /^\s*MessageBox\b/.test(line));
  assert.ok(messageBoxes.length > 0, 'installer has no auditable MessageBox commands');
  for (const messageBox of messageBoxes) {
    assert.match(
      messageBox,
      /\/SD\s+ID[A-Z]+\b/,
      `silent mode could wait on a MessageBox without a safe /SD default: ${messageBox.trim()}`
    );
  }

  const uninstallStart = nsis.indexOf('Section "Uninstall"');
  const uninstallEnd = nsis.indexOf('SectionEnd', uninstallStart);
  assert.notEqual(uninstallStart, -1, 'uninstall section is missing');
  assert.notEqual(uninstallEnd, -1, 'uninstall section terminator is missing');
  const uninstallSection = nsis.slice(uninstallStart, uninstallEnd);
  assertBefore(uninstallSection, 'Call un.RemoveClaudeConfig', 'Call un.DetectFoundryInstallation');
  assertBefore(uninstallSection, 'Call un.RemoveClaudeConfig', 'Call un.RemoveOwnedPayload');
  assertBefore(
    uninstallSection,
    'Call un.RemoveClaudeConfig',
    'Delete "$SMPROGRAMS\\${START_MENU_FOLDER}\\${PRODUCT_NAME}.lnk"'
  );
  assertIncludes(
    uninstallSection,
    '/SD IDCANCEL IDRETRY client_config_cleanup_retry IDCANCEL client_config_cleanup_abort'
  );
  assertIncludes(uninstallSection, 'SetErrorLevel 2');
  assertIncludes(nsis, 'StrCmp $2 "0" client_config_cleanup_done', 'client cleanup success gate');
  assertBefore(
    nsis,
    'Call CleanFoundryModulePayload',
    'CreateDirectory "$FoundryPath\\foundry-mcp-bridge"'
  );
  assertIncludes(nsis, 'Call un.CleanFoundryModulePayload');

  for (const forbidden of [
    'ExecWait "$PreviousInstallDir\\Uninstall.exe',
    "ExecWait '$PreviousInstallDir\\Uninstall.exe",
    'taskkill',
    'Stop-Process',
    'Get-Process node',
    'RMDir /r "$INSTDIR"',
    'RMDir /r "$APPDATA\\FoundryVTT MCP Bridge"',
    'RMDir /r "$FoundryPath\\foundry-mcp-bridge',
    'RMDir /r "$un.FoundryPath\\foundry-mcp-bridge',
  ]) {
    assert.ok(!nsis.includes(forbidden), `unsafe installer construct present: ${forbidden}`);
  }
  assert.ok(!stop.includes('Stop-Process'), 'shutdown helper must not terminate processes broadly');
  assert.ok(!stop.includes('taskkill'), 'shutdown helper must not use taskkill');
  assertIncludes(stop, 'Get-ExactOwnedWrapperProcesses');
  assertIncludes(stop, 'Test-PathEqual ([string]$arguments[1]) $layout.Script');
  assertIncludes(stop, 'Invoke-CimMethod -InputObject $wrapper.Process -MethodName Terminate');
  assertIncludes(stop, 'Remove-ExactLegacyRootShortcut');
  assert.ok(
    !desktopMain.includes('new Notification('),
    'native close notification can create a duplicate root Start Menu shortcut'
  );

  for (const required of [
    '$ProductId = "io.github.webmaster94.foundry-vtt-mcp"',
    'installer-owned-files.json',
    'Assert-NoReparseAncestors',
    'Assert-TreeHasNoReparsePoints',
    'Refusing legacy cleanup without the full legacy ownership fingerprint',
    'Existing canonical server configuration is invalid and was left unchanged',
  ]) {
    assertIncludes(migration, required);
  }
  assertIncludes(configure, 'FOUNDRY_MCP_MANAGED_BY');
  assertIncludes(configure, 'Test-EntryOwnedByBridge');
  assertIncludes(configure, 'Get-OnlyArgument');
  assertIncludes(configure, 'Claude Code (user scope)');
  assertIncludes(configure, 'FoundryVTT MCP Bridge\\foundry-servers.json');
  assertIncludes(configureCodex, "const OWNER_ID = 'io.github.webmaster94.foundry-vtt-mcp'");
  assertIncludes(configureCodex, 'function planInstall');
  assertIncludes(configureCodex, 'function planRemoval');
  assertIncludes(configureCodex, 'Codex configuration changed during migration');
  assertIncludes(moduleCleanup, 'Assert-TreeHasNoReparsePoints');
  assertIncludes(moduleCleanup, 'Remove-TreeNoFollow');
  assertIncludes(moduleCleanup, 'Preflight every allowlisted target');
  assertIncludes(nsis, 'configure-codex.mjs');
  assertIncludes(nsis, 'foundry-module-cleanup.ps1');
  assertIncludes(nsis, 'StrCmp $ClientConfigMigrationSafe "1" 0 migration_finalize_skipped');
  assertIncludes(build, "path.join(repoRoot, 'packages', 'desktop', 'release', 'win-unpacked')");
  assertIncludes(build, "path.join(payloadDir, 'runtime')");
  assertIncludes(build, "path.join(payloadDir, 'resources', 'server')");
  assertIncludes(build, 'Official checksum is missing');
  assertIncludes(build, "path.join(repoRoot, 'scripts', 'check-version-consistency.mjs')");
  assertIncludes(build, "runNpm(['run', 'bundle:server'])");
  assertIncludes(build, '--skip-server-build is static-test-only');
  assertIncludes(build, 'FoundryVTT-MCP-Bridge-Setup-${options.versionLabel}.exe');
  assert.ok(!build.includes('FoundryMCPServer-Setup-'), 'legacy installer artifact name remains');
  assertIncludes(releaseWorkflow, 'FoundryVTT-MCP-Bridge-Setup-${{ env.PACKAGE_VERSION }}.exe');
  assertIncludes(releaseWorkflow, 'npm run test:windows-installer-safety');
  assert.equal(
    rootPackage.scripts['test:windows-installer-safety'],
    'node installer/tests/windows-installer-safety.mjs'
  );

  const mismatch = spawnSync(
    process.execPath,
    [
      buildPath,
      '--version',
      '9.9.9',
      '--skip-download',
      '--skip-nsis',
      '--skip-server-build',
      '--skip-desktop-build',
    ],
    { encoding: 'utf8', windowsHide: true }
  );
  assert.notEqual(mismatch.status, 0, 'installer builder accepted a mismatched manifest version');
  assert.match(
    `${mismatch.stdout}${mismatch.stderr}`,
    /selected release version 9\.9\.9 does not match manifests/,
    'installer builder did not report the manifest mismatch'
  );

  const unsafeServerSkip = spawnSync(process.execPath, [buildPath, '--skip-server-build'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(unsafeServerSkip.status, 0, 'release compile accepted --skip-server-build');
  assert.match(
    `${unsafeServerSkip.stdout}${unsafeServerSkip.stderr}`,
    /--skip-server-build is static-test-only/,
    'installer builder did not explain the unsafe server-build skip'
  );
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeWindowsShortcut(shortcutPath, targetPath, environment) {
  fs.mkdirSync(path.dirname(shortcutPath), { recursive: true });
  const script = String.raw`
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($env:FOUNDRY_MCP_TEST_SHORTCUT)
$shortcut.TargetPath = $env:FOUNDRY_MCP_TEST_TARGET
$shortcut.WorkingDirectory = Split-Path -Parent $env:FOUNDRY_MCP_TEST_TARGET
$shortcut.Save()
`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      env: {
        ...environment,
        FOUNDRY_MCP_TEST_SHORTCUT: shortcutPath,
        FOUNDRY_MCP_TEST_TARGET: targetPath,
      },
      windowsHide: true,
    }
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Could not create shortcut fixture: ${result.stderr}`);
}

function validConfig(label = 'Fixture') {
  return {
    defaultServer: 'fixture',
    servers: {
      fixture: { label, host: 'localhost', port: 31415, connectionType: 'auto' },
    },
  };
}

function runPowerShell(script, args, environment, expectSuccess = true) {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      ...args,
    ],
    { encoding: 'utf8', env: environment, windowsHide: true }
  );
  if (result.error) throw result.error;
  if (expectSuccess) {
    assert.equal(
      result.status,
      0,
      `${path.basename(script)} failed:\n${result.stdout}\n${result.stderr}`
    );
  } else {
    assert.notEqual(result.status, 0, `${path.basename(script)} unexpectedly succeeded`);
  }
  return result;
}

function runNodeScript(script, args, environment, expectSuccess = true) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: environment,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (expectSuccess) {
    assert.equal(
      result.status,
      0,
      `${path.basename(script)} failed:\n${result.stdout}\n${result.stderr}`
    );
  } else {
    assert.notEqual(result.status, 0, `${path.basename(script)} unexpectedly succeeded`);
  }
  return result;
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Process ${child.pid} did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.once('exit', code => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

async function waitForPath(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for fixture signal: ${file}`);
}

function createOwnedInstall(root, ownedNames, extraFiles = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'foundry-vtt-mcp-bridge.install-id'), `${productId}\n`);
  for (const [relative, contents] of Object.entries(extraFiles)) {
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  }
  const files = ['foundry-vtt-mcp-bridge.install-id', ...ownedNames, 'installer-owned-files.json'];
  writeJson(path.join(root, 'installer-owned-files.json'), {
    schemaVersion: 1,
    productId,
    version: '0.13.0',
    files,
  });
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForLine(child, expected) {
  return await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(
      () => reject(new Error(`timed out waiting for ${expected}: ${output}`)),
      5000
    );
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes(expected)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`fixture control server exited early with ${code}: ${output}`));
    });
  });
}

async function runWindowsFixtures() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-mcp-installer-safety-'));
  const localAppData = path.join(fixtureRoot, 'LocalAppData');
  const appData = path.join(fixtureRoot, 'AppData');
  const environment = {
    ...process.env,
    LOCALAPPDATA: localAppData,
    APPDATA: appData,
    TEMP: path.join(fixtureRoot, 'Temp'),
    TMP: path.join(fixtureRoot, 'Temp'),
    USERPROFILE: path.join(fixtureRoot, 'UserProfile'),
    FOUNDRY_SERVERS_CONFIG: '',
  };
  fs.mkdirSync(environment.TEMP, { recursive: true });
  fs.mkdirSync(environment.USERPROFILE, { recursive: true });

  try {
    const cleanRoot = path.join(localAppData, 'Programs', 'Clean Bridge');
    const canonicalConfig = path.join(appData, 'FoundryVTT MCP Bridge', 'foundry-servers.json');
    const cleanState = path.join(fixtureRoot, 'clean-state.json');
    runPowerShell(
      migrationPath,
      [
        '-Phase',
        'Prepare',
        '-NewInstallDir',
        cleanRoot,
        '-CanonicalConfigPath',
        canonicalConfig,
        '-StateFile',
        cleanState,
        '-DisableRegistryDiscovery',
      ],
      environment
    );
    assert.deepEqual(JSON.parse(read(canonicalConfig)).servers.default.port, 31415);

    const preservedBytes = `${JSON.stringify(validConfig('Preserved'), null, 2)}\n`;
    fs.writeFileSync(canonicalConfig, preservedBytes);
    runPowerShell(
      migrationPath,
      [
        '-Phase',
        'Prepare',
        '-NewInstallDir',
        path.join(localAppData, 'Programs', 'Preserve Bridge'),
        '-CanonicalConfigPath',
        canonicalConfig,
        '-StateFile',
        path.join(fixtureRoot, 'preserve-state.json'),
        '-DisableRegistryDiscovery',
      ],
      environment
    );
    assert.equal(read(canonicalConfig), preservedBytes, 'canonical config was rewritten');

    const claudeSource = path.join(fixtureRoot, 'source-configs', 'claude-servers.json');
    const claudeSourceBytes = `${JSON.stringify(validConfig('Claude-discovered'), null, 2)}\n`;
    fs.mkdirSync(path.dirname(claudeSource), { recursive: true });
    fs.writeFileSync(claudeSource, claudeSourceBytes);
    const knownClaudeConfig = path.join(appData, 'Claude', 'claude_desktop_config.json');
    writeJson(knownClaudeConfig, {
      mcpServers: {
        'foundry-mcp': {
          command: 'node',
          args: ['source-wrapper.cjs'],
          env: { FOUNDRY_SERVERS_CONFIG: claudeSource },
        },
      },
    });
    const claudeDiscoveredCanonical = path.join(
      appData,
      'Claude Discovery Fixture',
      'foundry-servers.json'
    );
    runPowerShell(
      migrationPath,
      [
        '-Phase',
        'Prepare',
        '-NewInstallDir',
        path.join(localAppData, 'Programs', 'Claude Discovery Bridge'),
        '-CanonicalConfigPath',
        claudeDiscoveredCanonical,
        '-StateFile',
        path.join(fixtureRoot, 'claude-discovery-state.json'),
        '-DisableRegistryDiscovery',
      ],
      environment
    );
    assert.equal(read(claudeDiscoveredCanonical), claudeSourceBytes);
    fs.rmSync(knownClaudeConfig);

    const codexSource = path.join(fixtureRoot, 'source-configs', 'codex-servers.json');
    const codexSourceBytes = `${JSON.stringify(validConfig('Codex-discovered'), null, 2)}\n`;
    fs.writeFileSync(codexSource, codexSourceBytes);
    const codexDecoySource = path.join(fixtureRoot, 'source-configs', 'codex-decoy.json');
    fs.writeFileSync(
      codexDecoySource,
      `${JSON.stringify(validConfig('Quoted dotted-name decoy'), null, 2)}\n`
    );
    const codexConfig = path.join(environment.USERPROFILE, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
    fs.writeFileSync(
      codexConfig,
      `[mcp_servers."foundry-mcp.env"]\n` +
        `FOUNDRY_SERVERS_CONFIG = ${JSON.stringify(codexDecoySource)}\n\n` +
        `["mcp_servers"."foundry-mcp"."env"]\n` +
        `FOUNDRY_SERVERS_CONFIG = ${JSON.stringify(codexSource)}\n`
    );
    const codexDiscoveredCanonical = path.join(
      appData,
      'Codex Discovery Fixture',
      'foundry-servers.json'
    );
    runPowerShell(
      migrationPath,
      [
        '-Phase',
        'Prepare',
        '-NewInstallDir',
        path.join(localAppData, 'Programs', 'Codex Discovery Bridge'),
        '-CanonicalConfigPath',
        codexDiscoveredCanonical,
        '-StateFile',
        path.join(fixtureRoot, 'codex-discovery-state.json'),
        '-DisableRegistryDiscovery',
      ],
      environment
    );
    assert.equal(read(codexDiscoveredCanonical), codexSourceBytes);
    fs.rmSync(codexConfig);

    const legacyRoot = path.join(fixtureRoot, 'Legacy Custom');
    fs.mkdirSync(path.join(legacyRoot, 'foundry-mcp-server', 'packages', 'mcp-server', 'dist'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(legacyRoot, 'node.exe'), 'fixture node');
    fs.writeFileSync(path.join(legacyRoot, 'Uninstall.exe'), 'fixture uninstaller');
    fs.writeFileSync(
      path.join(legacyRoot, 'foundry-mcp-server', 'packages', 'mcp-server', 'dist', 'index.cjs'),
      'fixture server'
    );
    fs.writeFileSync(
      path.join(legacyRoot, 'foundry-servers.json'),
      `${JSON.stringify(validConfig('Legacy'))}\n`
    );
    fs.writeFileSync(path.join(legacyRoot, 'user-sentinel.txt'), 'preserve me');
    const migratedCanonical = path.join(appData, 'Migration Fixture', 'foundry-servers.json');
    const newRoot = path.join(localAppData, 'Programs', 'Foundry VTT MCP Bridge');
    const migrationState = path.join(fixtureRoot, 'migration-state.json');
    runPowerShell(
      migrationPath,
      [
        '-Phase',
        'Prepare',
        '-NewInstallDir',
        newRoot,
        '-CanonicalConfigPath',
        migratedCanonical,
        '-PreviousInstallDir',
        legacyRoot,
        '-StateFile',
        migrationState,
        '-DisableRegistryDiscovery',
      ],
      environment
    );
    createOwnedInstall(newRoot, ['app.bin'], { 'app.bin': 'new app' });
    runPowerShell(
      migrationPath,
      [
        '-Phase',
        'Finalize',
        '-NewInstallDir',
        newRoot,
        '-CanonicalConfigPath',
        migratedCanonical,
        '-StateFile',
        migrationState,
        '-DisableRegistryDiscovery',
      ],
      environment
    );
    assert.equal(JSON.parse(read(migratedCanonical)).servers.fixture.label, 'Legacy');
    assert.ok(
      fs.existsSync(path.join(legacyRoot, 'foundry-servers.json')),
      'legacy config source removed'
    );
    assert.ok(
      fs.existsSync(path.join(legacyRoot, 'user-sentinel.txt')),
      'unknown legacy file removed'
    );
    assert.ok(
      !fs.existsSync(path.join(legacyRoot, 'node.exe')),
      'legacy allowlist was not cleaned'
    );
    assert.ok(
      !fs.existsSync(path.join(legacyRoot, 'Uninstall.exe')),
      'legacy uninstaller survived'
    );

    const outsideSentinel = path.join(fixtureRoot, 'outside-sentinel.txt');
    fs.writeFileSync(outsideSentinel, 'outside');
    const maliciousRoot = path.join(localAppData, 'Programs', 'Malicious Manifest');
    createOwnedInstall(maliciousRoot, ['inside.bin'], { 'inside.bin': 'inside' });
    const maliciousManifest = JSON.parse(
      read(path.join(maliciousRoot, 'installer-owned-files.json'))
    );
    maliciousManifest.files.unshift('..\\..\\..\\outside-sentinel.txt');
    writeJson(path.join(maliciousRoot, 'installer-owned-files.json'), maliciousManifest);
    runPowerShell(
      migrationPath,
      [
        '-Phase',
        'Prepare',
        '-NewInstallDir',
        maliciousRoot,
        '-CanonicalConfigPath',
        canonicalConfig,
        '-StateFile',
        path.join(fixtureRoot, 'malicious-state.json'),
        '-DisableRegistryDiscovery',
      ],
      environment,
      false
    );
    assert.equal(read(outsideSentinel), 'outside');
    assert.ok(fs.existsSync(path.join(maliciousRoot, 'inside.bin')), 'preflight was not atomic');

    const junctionTarget = path.join(fixtureRoot, 'junction-target');
    const junctionRoot = path.join(localAppData, 'Programs', 'Junction Bridge');
    fs.mkdirSync(junctionTarget, { recursive: true });
    fs.writeFileSync(path.join(junctionTarget, 'sentinel.txt'), 'junction target');
    fs.mkdirSync(path.dirname(junctionRoot), { recursive: true });
    fs.symlinkSync(junctionTarget, junctionRoot, 'junction');
    runPowerShell(
      migrationPath,
      [
        '-Phase',
        'Prepare',
        '-NewInstallDir',
        junctionRoot,
        '-CanonicalConfigPath',
        canonicalConfig,
        '-StateFile',
        path.join(fixtureRoot, 'junction-state.json'),
        '-DisableRegistryDiscovery',
      ],
      environment,
      false
    );
    assert.equal(read(path.join(junctionTarget, 'sentinel.txt')), 'junction target');

    for (const mode of ['Replace', 'Uninstall']) {
      const moduleFixture = path.join(fixtureRoot, `Nested Module ${mode}`);
      const moduleRoot = path.join(moduleFixture, 'FoundryData', 'modules', 'foundry-mcp-bridge');
      const externalModuleTarget = path.join(moduleFixture, 'external-module-target');
      fs.mkdirSync(path.join(moduleRoot, 'dist'), { recursive: true });
      fs.mkdirSync(path.join(moduleRoot, 'templates'), { recursive: true });
      fs.mkdirSync(externalModuleTarget, { recursive: true });
      fs.writeFileSync(path.join(moduleRoot, 'dist', 'owned-before-link.js'), 'owned');
      fs.writeFileSync(path.join(moduleRoot, 'module.json'), '{"id":"foundry-mcp-bridge"}\n');
      fs.writeFileSync(path.join(externalModuleTarget, 'external-sentinel.txt'), 'external');
      fs.symlinkSync(
        externalModuleTarget,
        path.join(moduleRoot, 'templates', 'nested-junction'),
        'junction'
      );
      runPowerShell(
        moduleCleanupPath,
        ['-ModuleRoot', moduleRoot, '-Mode', mode],
        environment,
        false
      );
      assert.equal(
        read(path.join(externalModuleTarget, 'external-sentinel.txt')),
        'external',
        `${mode} followed a nested module junction`
      );
      assert.ok(
        fs.existsSync(path.join(moduleRoot, 'dist', 'owned-before-link.js')),
        `${mode} mutated an earlier owned tree before completing reparse preflight`
      );
      assert.ok(
        fs.existsSync(path.join(moduleRoot, 'module.json')),
        `${mode} removed module metadata after failed reparse preflight`
      );
    }

    const safeModuleRoot = path.join(
      fixtureRoot,
      'Safe Module Replace',
      'FoundryData',
      'modules',
      'foundry-mcp-bridge'
    );
    fs.mkdirSync(path.join(safeModuleRoot, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(safeModuleRoot, 'generated-maps'), { recursive: true });
    fs.writeFileSync(path.join(safeModuleRoot, 'dist', 'old.js'), 'old module code');
    fs.writeFileSync(path.join(safeModuleRoot, 'module.json'), '{"id":"foundry-mcp-bridge"}\n');
    fs.writeFileSync(path.join(safeModuleRoot, 'generated-maps', 'map.webp'), 'user map');
    runPowerShell(
      moduleCleanupPath,
      ['-ModuleRoot', safeModuleRoot, '-Mode', 'Replace'],
      environment
    );
    assert.ok(!fs.existsSync(path.join(safeModuleRoot, 'dist')), 'owned module code survived');
    assert.ok(!fs.existsSync(path.join(safeModuleRoot, 'module.json')), 'metadata survived');
    assert.ok(
      fs.existsSync(path.join(safeModuleRoot, 'generated-maps', 'map.webp')),
      'unknown/generated module content was removed'
    );

    const uninstallRoot = path.join(localAppData, 'Programs', 'Uninstall Fixture');
    createOwnedInstall(uninstallRoot, ['app.bin'], { 'app.bin': 'owned app' });
    const userDataExtra = path.join(appData, 'FoundryVTT MCP Bridge', 'window-state.json');
    fs.writeFileSync(userDataExtra, '{"x":1}\n');
    runPowerShell(
      migrationPath,
      [
        '-Phase',
        'Uninstall',
        '-NewInstallDir',
        uninstallRoot,
        '-CanonicalConfigPath',
        canonicalConfig,
        '-DisableRegistryDiscovery',
      ],
      environment
    );
    assert.ok(!fs.existsSync(path.join(uninstallRoot, 'app.bin')));
    assert.ok(fs.existsSync(canonicalConfig), 'canonical config removed on uninstall');
    assert.ok(fs.existsSync(userDataExtra), 'Electron userData removed on uninstall');

    const configuredInstall = path.join(fixtureRoot, 'Configured Install');
    fs.mkdirSync(path.join(configuredInstall, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(configuredInstall, 'resources', 'server'), { recursive: true });
    fs.writeFileSync(path.join(configuredInstall, 'FoundryVTT MCP Bridge.exe'), 'desktop');
    fs.writeFileSync(path.join(configuredInstall, 'runtime', 'node.exe'), 'node');
    fs.writeFileSync(
      path.join(configuredInstall, 'resources', 'server', 'index.bundle.cjs'),
      'server'
    );
    const legacyClientRoot = path.join(fixtureRoot, 'Legacy Client Install');
    const legacyClientConfig = path.join(fixtureRoot, 'Claude', 'legacy-client-config.json');
    writeJson(legacyClientConfig, {
      mcpServers: {
        'foundry-mcp': {
          command: path.join(legacyClientRoot, 'node.exe'),
          args: [
            path.join(
              legacyClientRoot,
              'foundry-mcp-server',
              'packages',
              'mcp-server',
              'dist',
              'index.cjs'
            ),
          ],
        },
        'foundry-vtt-mcp': {
          command: path.join(legacyClientRoot, 'node.exe'),
          args: [
            path.join(
              legacyClientRoot,
              'foundry-mcp-server',
              'packages',
              'mcp-server',
              'dist',
              'index.cjs'
            ),
          ],
        },
        other: { command: 'other', args: [] },
      },
    });
    const legacyClientBytes = fs.readFileSync(legacyClientConfig);
    runPowerShell(
      configurePath,
      ['-InstallDir', configuredInstall, '-ConfigPathOverride', legacyClientConfig],
      environment
    );
    const migratedClientEntries = JSON.parse(read(legacyClientConfig)).mcpServers;
    assertSamePath(
      migratedClientEntries['foundry-mcp'].command,
      path.join(configuredInstall, 'FoundryVTT MCP Bridge.exe')
    );
    assert.equal(migratedClientEntries['foundry-mcp'].env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(migratedClientEntries['foundry-mcp'].env.FOUNDRY_MCP_MANAGED_BY, productId);
    assertSamePath(
      migratedClientEntries['foundry-mcp'].env.FOUNDRY_SERVERS_CONFIG,
      path.join(appData, 'FoundryVTT MCP Bridge', 'foundry-servers.json')
    );
    assert.ok(!migratedClientEntries['foundry-vtt-mcp'], 'owned legacy alias survived migration');
    assert.ok(migratedClientEntries.other, 'client migration removed an unrelated entry');
    const legacyClientBackups = fs
      .readdirSync(path.dirname(legacyClientConfig))
      .filter(name => name.startsWith(`${path.basename(legacyClientConfig)}.backup-`));
    assert.equal(legacyClientBackups.length, 1, 'JSON migration backup was not created once');
    assert.deepEqual(
      fs.readFileSync(path.join(path.dirname(legacyClientConfig), legacyClientBackups[0])),
      legacyClientBytes,
      'JSON migration backup did not preserve the exact preimage'
    );

    const claudeCodeConfig = path.join(fixtureRoot, 'Claude Code', '.claude.json');
    writeJson(claudeCodeConfig, {
      mcpServers: {
        'foundry-mcp': {
          command: path.join(legacyClientRoot, 'node.exe'),
          args: [
            path.join(
              legacyClientRoot,
              'foundry-mcp-server',
              'packages',
              'mcp-server',
              'dist',
              'index.cjs'
            ),
          ],
        },
        other: { command: 'other', args: [] },
      },
    });
    runPowerShell(
      configurePath,
      ['-InstallDir', configuredInstall, '-ClaudeCodeConfigPathOverride', claudeCodeConfig],
      environment
    );
    const migratedClaudeCode = JSON.parse(read(claudeCodeConfig)).mcpServers;
    assertSamePath(
      migratedClaudeCode['foundry-mcp'].command,
      path.join(configuredInstall, 'FoundryVTT MCP Bridge.exe')
    );
    assert.equal(migratedClaudeCode['foundry-mcp'].env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(migratedClaudeCode['foundry-mcp'].env.FOUNDRY_MCP_MANAGED_BY, productId);
    assert.ok(migratedClaudeCode.other, 'Claude Code migration removed an unrelated entry');

    const foreignClientConfig = path.join(fixtureRoot, 'Claude', 'foreign-client-config.json');
    writeJson(foreignClientConfig, {
      mcpServers: {
        'foundry-mcp': {
          command: 'C:\\Unrelated\\node.exe',
          args: ['C:\\Unrelated\\server.cjs'],
        },
      },
    });
    const foreignClientBytes = read(foreignClientConfig);
    runPowerShell(
      configurePath,
      ['-InstallDir', configuredInstall, '-ConfigPathOverride', foreignClientConfig],
      environment,
      false
    );
    assert.equal(
      read(foreignClientConfig),
      foreignClientBytes,
      'foreign same-name entry was rewritten'
    );

    const foreignClaudeCodeConfig = path.join(fixtureRoot, 'Claude Code', 'foreign.json');
    writeJson(foreignClaudeCodeConfig, {
      mcpServers: {
        'foundry-mcp': {
          command: 'C:\\Unrelated\\node.exe',
          args: ['C:\\Unrelated\\server.cjs', '--extra-argument'],
        },
      },
    });
    const foreignClaudeCodeBytes = read(foreignClaudeCodeConfig);
    runPowerShell(
      configurePath,
      ['-InstallDir', configuredInstall, '-ClaudeCodeConfigPathOverride', foreignClaudeCodeConfig],
      environment,
      false
    );
    assert.equal(
      read(foreignClaudeCodeConfig),
      foreignClaudeCodeBytes,
      'foreign Claude Code same-name entry was rewritten'
    );

    const concurrentJsonConfig = path.join(fixtureRoot, 'Claude Concurrent', 'config.json');
    writeJson(concurrentJsonConfig, {
      mcpServers: {
        'foundry-mcp': {
          command: path.join(legacyClientRoot, 'node.exe'),
          args: [
            path.join(
              legacyClientRoot,
              'foundry-mcp-server',
              'packages',
              'mcp-server',
              'dist',
              'index.cjs'
            ),
          ],
        },
      },
    });
    const concurrentSignal = path.join(fixtureRoot, 'claude-concurrent-ready.txt');
    const concurrentProcess = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        configurePath,
        '-InstallDir',
        configuredInstall,
        '-ConfigPathOverride',
        concurrentJsonConfig,
        '-BeforeWriteSignalPath',
        concurrentSignal,
        '-BeforeWriteDelayMilliseconds',
        '1000',
      ],
      { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    await waitForPath(concurrentSignal);
    const concurrentReplacement = `${JSON.stringify(
      { mcpServers: { concurrent: { command: 'preserve-me', args: [] } } },
      null,
      2
    )}\n`;
    fs.writeFileSync(concurrentJsonConfig, concurrentReplacement);
    const concurrentExitCode = await waitForExit(concurrentProcess);
    assert.notEqual(concurrentExitCode, 0, 'concurrent JSON update was overwritten');
    assert.equal(
      read(concurrentJsonConfig),
      concurrentReplacement,
      'concurrent JSON client change was not preserved byte-for-byte'
    );
    assert.equal(
      fs
        .readdirSync(path.dirname(concurrentJsonConfig))
        .filter(name => name.startsWith(`${path.basename(concurrentJsonConfig)}.backup-`)).length,
      0,
      'rejected concurrent JSON update created a misleading backup'
    );

    const linkedJsonTarget = path.join(fixtureRoot, 'Claude Linked', 'target.json');
    const linkedJsonConfig = path.join(fixtureRoot, 'Claude Linked', 'config-link.json');
    writeJson(linkedJsonTarget, {
      mcpServers: {
        'foundry-mcp': {
          command: path.join(legacyClientRoot, 'node.exe'),
          args: [
            path.join(
              legacyClientRoot,
              'foundry-mcp-server',
              'packages',
              'mcp-server',
              'dist',
              'index.cjs'
            ),
          ],
        },
      },
    });
    const linkedJsonTargetBytes = fs.readFileSync(linkedJsonTarget);
    let linkedFixtureCreated = false;
    try {
      fs.symlinkSync(linkedJsonTarget, linkedJsonConfig, 'file');
      linkedFixtureCreated = true;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    }
    if (linkedFixtureCreated) {
      runPowerShell(
        configurePath,
        ['-InstallDir', configuredInstall, '-ConfigPathOverride', linkedJsonConfig],
        environment,
        false
      );
      assert.deepEqual(
        fs.readFileSync(linkedJsonTarget),
        linkedJsonTargetBytes,
        'linked JSON target was modified'
      );
    }

    const legacyCodexRoot = path.join(fixtureRoot, 'Legacy Codex Install');
    const legacyCodexConfig = path.join(fixtureRoot, 'Codex', 'legacy-config.toml');
    fs.mkdirSync(path.dirname(legacyCodexConfig), { recursive: true });
    const legacyCodexBytes =
      `# unrelated preamble\r\n` +
      `[features]\r\n` +
      `preserved = true\r\n\r\n` +
      `[mcp_servers."foundry-mcp"]\r\n` +
      `command = ${JSON.stringify(path.join(legacyCodexRoot, 'node.exe'))}\r\n` +
      `args = [${JSON.stringify(
        path.join(
          legacyCodexRoot,
          'foundry-mcp-server',
          'packages',
          'mcp-server',
          'dist',
          'index.cjs'
        )
      )}]\r\n\r\n` +
      `[mcp_servers.'foundry-vtt-mcp']\r\n` +
      `command = "C:\\\\missing\\\\node.exe"\r\n` +
      `args = ["C:\\\\missing\\\\bundle.cjs"]\r\n\r\n` +
      `[mcp_servers.'foundry-vtt-mcp'.env]\r\n` +
      `FOUNDRY_MCP_MANAGED_BY = ${JSON.stringify(productId)}\r\n\r\n` +
      `[mcp_servers.other]\r\n` +
      `command = "other"\r\n` +
      `args = []\r\n`;
    fs.writeFileSync(legacyCodexConfig, legacyCodexBytes);
    runNodeScript(
      configureCodexPath,
      ['--install-dir', configuredInstall, '--config', legacyCodexConfig],
      environment
    );
    const migratedCodex = read(legacyCodexConfig);
    assert.ok(
      migratedCodex.includes(
        `command = ${JSON.stringify(path.join(configuredInstall, 'FoundryVTT MCP Bridge.exe'))}`
      ),
      'Codex command was not migrated'
    );
    assert.ok(
      migratedCodex.includes('ELECTRON_RUN_AS_NODE = "1"'),
      'Codex Electron Node mode was not configured'
    );
    assert.ok(
      migratedCodex.includes(
        `args = [${JSON.stringify(
          path.join(configuredInstall, 'resources', 'server', 'index.bundle.cjs')
        )}]`
      ),
      'Codex bundle was not migrated'
    );
    assert.ok(
      migratedCodex.includes(
        `FOUNDRY_SERVERS_CONFIG = ${JSON.stringify(
          path.join(appData, 'FoundryVTT MCP Bridge', 'foundry-servers.json')
        )}`
      ),
      'Codex canonical config path was not migrated'
    );
    assert.ok(
      !migratedCodex.includes(`[mcp_servers.'foundry-vtt-mcp']`) &&
        !migratedCodex.includes(`[mcp_servers."foundry-vtt-mcp"]`),
      'owned Codex alias survived migration'
    );
    assert.ok(
      migratedCodex.includes('[mcp_servers.other]\r\ncommand = "other"\r\nargs = []\r\n'),
      'Codex migration changed an unrelated table'
    );
    const codexBackups = fs
      .readdirSync(path.dirname(legacyCodexConfig))
      .filter(name => name.startsWith(`${path.basename(legacyCodexConfig)}.backup-`));
    assert.equal(codexBackups.length, 1, 'Codex migration backup was not created exactly once');
    assert.equal(
      fs.readFileSync(path.join(path.dirname(legacyCodexConfig), codexBackups[0]), 'utf8'),
      legacyCodexBytes,
      'Codex migration backup did not preserve the exact preimage'
    );

    const foreignCodexConfig = path.join(fixtureRoot, 'Codex Foreign', 'config.toml');
    fs.mkdirSync(path.dirname(foreignCodexConfig), { recursive: true });
    const foreignCodexBytes =
      `[mcp_servers.foundry-mcp]\n` +
      `command = "C:\\\\Unrelated\\\\node.exe"\n` +
      `args = ["C:\\\\Unrelated\\\\server.cjs", "--extra"]\n`;
    fs.writeFileSync(foreignCodexConfig, foreignCodexBytes);
    runNodeScript(
      configureCodexPath,
      ['--install-dir', configuredInstall, '--config', foreignCodexConfig],
      environment,
      false
    );
    assert.equal(read(foreignCodexConfig), foreignCodexBytes, 'foreign Codex entry was rewritten');
    assert.equal(
      fs.readdirSync(path.dirname(foreignCodexConfig)).filter(name => name.includes('.backup-'))
        .length,
      0,
      'refused foreign Codex entry created a backup'
    );

    const multilineCodexConfig = path.join(fixtureRoot, 'Codex Multiline', 'config.toml');
    fs.mkdirSync(path.dirname(multilineCodexConfig), { recursive: true });
    const multilineCodexBytes =
      `[mcp_servers.foundry-mcp]\n` +
      `command = "C:\\\\Foreign\\\\node.exe"\n` +
      `args = ["C:\\\\Foreign\\\\server.cjs"]\n\n` +
      `[mcp_servers.foundry-mcp.env]\n` +
      `note = """\n` +
      `FOUNDRY_MCP_MANAGED_BY = ${JSON.stringify(productId)}\n` +
      `[mcp_servers.foundry-vtt-mcp]\n` +
      `"""\n`;
    fs.writeFileSync(multilineCodexConfig, multilineCodexBytes);
    runNodeScript(
      configureCodexPath,
      ['--install-dir', configuredInstall, '--config', multilineCodexConfig],
      environment,
      false
    );
    assert.equal(
      read(multilineCodexConfig),
      multilineCodexBytes,
      'marker/header text inside a multiline string was treated as configuration'
    );

    const preservedLegacyRoot = path.join(fixtureRoot, 'Preserved Foreign Upgrade');
    createOwnedInstall(preservedLegacyRoot, ['runtime\\node.exe'], {
      'runtime\\node.exe': 'previous runtime',
    });
    const preservedUpgradeState = path.join(fixtureRoot, 'preserved-upgrade-state.json');
    runPowerShell(
      migrationPath,
      [
        '-Phase',
        'Prepare',
        '-NewInstallDir',
        path.join(localAppData, 'Programs', 'Preserved Foreign Upgrade New'),
        '-CanonicalConfigPath',
        canonicalConfig,
        '-PreviousInstallDir',
        preservedLegacyRoot,
        '-StateFile',
        preservedUpgradeState,
        '-DisableRegistryDiscovery',
      ],
      environment
    );
    runNodeScript(
      configureCodexPath,
      ['--install-dir', configuredInstall, '--config', foreignCodexConfig],
      environment,
      false
    );
    assert.ok(
      fs.existsSync(path.join(preservedLegacyRoot, 'runtime', 'node.exe')),
      'foreign client refusal did not preserve the previous payload before the finalize gate'
    );

    const inlineCodexConfig = path.join(fixtureRoot, 'Codex Inline', 'config.toml');
    fs.mkdirSync(path.dirname(inlineCodexConfig), { recursive: true });
    const inlineCodexBytes = `mcp_servers.foundry-mcp.command = ${JSON.stringify(
      path.join(legacyCodexRoot, 'node.exe')
    )}\n`;
    fs.writeFileSync(inlineCodexConfig, inlineCodexBytes);
    runNodeScript(
      configureCodexPath,
      ['--install-dir', configuredInstall, '--config', inlineCodexConfig],
      environment,
      false
    );
    assert.equal(read(inlineCodexConfig), inlineCodexBytes, 'unsupported Codex syntax was changed');

    const mixedCodexConfig = path.join(fixtureRoot, 'Codex Remove', 'config.toml');
    fs.mkdirSync(path.dirname(mixedCodexConfig), { recursive: true });
    const mixedCodexText =
      `[mcp_servers."foundry-mcp"]\r\n` +
      `command = "C:\\\\Foreign\\\\node.exe"\r\n` +
      `args = ["C:\\\\Foreign\\\\server.cjs"]\r\n\r\n` +
      `[mcp_servers."foundry-vtt-mcp"]\r\n` +
      `command = ${JSON.stringify(path.join(configuredInstall, 'runtime', 'node.exe'))}\r\n` +
      `args = [${JSON.stringify(
        path.join(configuredInstall, 'resources', 'server', 'index.bundle.cjs')
      )}]\r\n\r\n` +
      `[mcp_servers."foundry-vtt-mcp-bridge"]\r\n` +
      `command = "C:\\\\Missing\\\\node.exe"\r\n` +
      `args = ["C:\\\\Missing\\\\server.cjs"]\r\n\r\n` +
      `[mcp_servers."foundry-vtt-mcp-bridge".env]\r\n` +
      `FOUNDRY_MCP_MANAGED_BY = ${JSON.stringify(productId)}\r\n\r\n` +
      `[mcp_servers."foundry-mcp.env"]\r\n` +
      `command = "quoted-dotted-name"\r\n`;
    const mixedCodexBytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(mixedCodexText, 'utf8'),
    ]);
    fs.writeFileSync(mixedCodexConfig, mixedCodexBytes);
    runNodeScript(
      configureCodexPath,
      ['--install-dir', configuredInstall, '--config', mixedCodexConfig, '--remove'],
      environment
    );
    const cleanedCodex = fs.readFileSync(mixedCodexConfig);
    assert.deepEqual(
      [...cleanedCodex.subarray(0, 3)],
      [0xef, 0xbb, 0xbf],
      'Codex UTF-8 BOM was not preserved'
    );
    const cleanedCodexText = cleanedCodex.subarray(3).toString('utf8');
    assert.ok(
      cleanedCodexText.includes(
        `[mcp_servers."foundry-mcp"]\r\ncommand = "C:\\\\Foreign\\\\node.exe"\r\nargs = ["C:\\\\Foreign\\\\server.cjs"]\r\n`
      ),
      'foreign Codex primary was changed during owned-only removal'
    );
    assert.ok(!cleanedCodexText.includes('foundry-vtt-mcp"]'), 'layout-owned alias survived');
    assert.ok(
      !cleanedCodexText.includes('foundry-vtt-mcp-bridge'),
      'marker-owned Codex alias survived'
    );
    assert.ok(
      cleanedCodexText.includes('[mcp_servers."foundry-mcp.env"]'),
      'quoted dotted Codex server name was conflated with an env table'
    );
    const mixedBackups = fs
      .readdirSync(path.dirname(mixedCodexConfig))
      .filter(name => name.startsWith(`${path.basename(mixedCodexConfig)}.backup-`));
    assert.equal(mixedBackups.length, 1, 'Codex removal did not create exactly one backup');
    assert.deepEqual(
      fs.readFileSync(path.join(path.dirname(mixedCodexConfig), mixedBackups[0])),
      mixedCodexBytes,
      'Codex removal backup was not byte-exact'
    );

    const claudeConfig = path.join(fixtureRoot, 'Claude', 'claude_desktop_config.json');
    writeJson(claudeConfig, {
      mcpServers: {
        'foundry-mcp': { command: 'C:\\Unrelated\\node.exe', args: ['C:\\Unrelated\\server.cjs'] },
        'foundry-vtt-mcp': {
          command: 'C:\\Old\\node.exe',
          args: ['C:\\Old\\somewhere.cjs'],
          env: { FOUNDRY_MCP_MANAGED_BY: productId },
        },
        'foundry-vtt-mcp-bridge': {
          command: path.join(configuredInstall, 'runtime', 'node.exe'),
          args: [path.join(configuredInstall, 'resources', 'server', 'index.bundle.cjs')],
        },
        other: { command: 'other', args: [] },
      },
    });
    runPowerShell(
      configurePath,
      ['-InstallDir', configuredInstall, '-Remove', '-ConfigPathOverride', claudeConfig],
      environment
    );
    const cleanedClaude = JSON.parse(read(claudeConfig)).mcpServers;
    assert.ok(cleanedClaude['foundry-mcp'], 'same-name unrelated entry was removed');
    assert.ok(cleanedClaude.other, 'unrelated MCP entry was removed');
    assert.ok(!cleanedClaude['foundry-vtt-mcp'], 'marker-owned entry survived');
    assert.ok(!cleanedClaude['foundry-vtt-mcp-bridge'], 'layout-owned entry survived');

    const wrapperScript = path.join(configuredInstall, 'resources', 'server', 'index.bundle.cjs');
    fs.copyFileSync(process.execPath, path.join(configuredInstall, 'FoundryVTT MCP Bridge.exe'));
    fs.copyFileSync(process.execPath, path.join(configuredInstall, 'runtime', 'node.exe'));
    fs.writeFileSync(
      wrapperScript,
      "process.stdout.write('READY\\n'); setInterval(() => {}, 1000);\n"
    );
    fs.writeFileSync(
      path.join(configuredInstall, 'foundry-vtt-mcp-bridge.install-id'),
      `${productId}\n`
    );
    const currentWrapper = spawn(
      path.join(configuredInstall, 'FoundryVTT MCP Bridge.exe'),
      [wrapperScript],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    const previousWrapper = spawn(
      path.join(configuredInstall, 'runtime', 'node.exe'),
      [wrapperScript],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    const foreignWrapperSentinel = spawn(
      process.execPath,
      ['-e', "process.stdout.write('READY\\n'); setInterval(() => {}, 1000);"],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    const obsoleteRootShortcut = path.join(
      appData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'FoundryVTT MCP Bridge.lnk'
    );
    writeWindowsShortcut(
      obsoleteRootShortcut,
      path.join(configuredInstall, 'FoundryVTT MCP Bridge.exe'),
      environment
    );
    try {
      await Promise.all([
        waitForLine(currentWrapper, 'READY'),
        waitForLine(previousWrapper, 'READY'),
        waitForLine(foreignWrapperSentinel, 'READY'),
      ]);
      const wrapperControlPort = await freePort();
      runPowerShell(
        stopPath,
        [
          '-InstallDir',
          configuredInstall,
          '-ControlPort',
          String(wrapperControlPort),
          '-TimeoutSeconds',
          '4',
        ],
        environment
      );
      await waitForExit(currentWrapper);
      await waitForExit(previousWrapper);
      assert.ok(
        !fs.existsSync(obsoleteRootShortcut),
        'exact obsolete root Start Menu shortcut survived guarded cleanup'
      );
      assert.equal(
        foreignWrapperSentinel.exitCode,
        null,
        'foreign Node process was terminated with the exact owned wrapper'
      );
    } finally {
      if (currentWrapper.exitCode === null) currentWrapper.kill();
      if (previousWrapper.exitCode === null) previousWrapper.kill();
      if (foreignWrapperSentinel.exitCode === null) foreignWrapperSentinel.kill();
    }

    writeWindowsShortcut(obsoleteRootShortcut, process.execPath, environment);
    runPowerShell(
      stopPath,
      ['-InstallDir', configuredInstall, '-ControlPort', String(await freePort())],
      environment
    );
    assert.ok(
      fs.existsSync(obsoleteRootShortcut),
      'foreign same-name root Start Menu shortcut was removed'
    );
    fs.rmSync(obsoleteRootShortcut);

    const legacyWrapperRoot = path.join(fixtureRoot, 'Legacy Wrapper Install');
    const legacyWrapperScript = path.join(
      legacyWrapperRoot,
      'foundry-mcp-server',
      'packages',
      'mcp-server',
      'dist',
      'index.cjs'
    );
    fs.mkdirSync(path.dirname(legacyWrapperScript), { recursive: true });
    fs.copyFileSync(process.execPath, path.join(legacyWrapperRoot, 'node.exe'));
    fs.writeFileSync(path.join(legacyWrapperRoot, 'Uninstall.exe'), 'legacy uninstaller');
    fs.writeFileSync(
      legacyWrapperScript,
      "process.stdout.write('READY\\n'); setInterval(() => {}, 1000);\n"
    );
    const legacyWrapper = spawn(path.join(legacyWrapperRoot, 'node.exe'), [legacyWrapperScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    try {
      await waitForLine(legacyWrapper, 'READY');
      const legacyWrapperControlPort = await freePort();
      runPowerShell(
        stopPath,
        [
          '-InstallDir',
          legacyWrapperRoot,
          '-ControlPort',
          String(legacyWrapperControlPort),
          '-TimeoutSeconds',
          '4',
          '-AllowLegacyIdentity',
        ],
        environment
      );
      await waitForExit(legacyWrapper);
    } finally {
      if (legacyWrapper.exitCode === null) legacyWrapper.kill();
    }

    const controlPort = await freePort();
    const foreignEntry = path.join(fixtureRoot, 'Foreign Product', 'backend.bundle.cjs');
    const foreignScript = `
      const net = require('node:net');
      const server = net.createServer(socket => {
        let data = '';
        socket.setEncoding('utf8');
        socket.on('data', chunk => {
          data += chunk;
          if (!data.includes('\\n')) return;
          const request = JSON.parse(data.trim());
          if (request.method === 'shutdown') process.stdout.write('SHUTDOWN_RECEIVED\\n');
          socket.end(JSON.stringify({ id: request.id, result: { ok: true, instanceId: 'foreign', entryPath: ${JSON.stringify(
            foreignEntry
          )} } }) + '\\n');
        });
      });
      server.listen(${controlPort}, '127.0.0.1', () => process.stdout.write('READY\\n'));
      setInterval(() => {}, 1000);
    `;
    const foreignProcess = spawn(process.execPath, ['-e', foreignScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    try {
      await waitForLine(foreignProcess, 'READY');
      runPowerShell(
        stopPath,
        [
          '-InstallDir',
          configuredInstall,
          '-ControlPort',
          String(controlPort),
          '-TimeoutSeconds',
          '3',
        ],
        environment
      );
      assert.equal(foreignProcess.exitCode, null, 'foreign Node/control process was terminated');
    } finally {
      foreignProcess.kill();
    }
  } finally {
    // Test-owned, fixed-prefix fixture only. Junctions are removed as links by
    // Node; their external targets are inside this same fixture root.
    if (path.basename(fixtureRoot).startsWith('foundry-mcp-installer-safety-')) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }
}

runStaticChecks();
if (process.platform === 'win32') {
  await runWindowsFixtures();
  console.log('[windows-installer-safety] PASS: static and isolated Windows fixtures');
} else {
  console.log(
    '[windows-installer-safety] PASS: static checks (Windows fixtures skipped on this host)'
  );
}
