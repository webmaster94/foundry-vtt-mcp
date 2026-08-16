#!/usr/bin/env node

/**
 * Stage and compile the per-user Windows installer.
 *
 * The installer payload starts with electron-builder's complete
 * packages/desktop/release/win-unpacked tree. This script then pins the latest
 * MCP bundles, a standalone Node runtime for MCP clients, and the guarded
 * migration/configuration helpers into that tree.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PRODUCT_ID = 'io.github.webmaster94.foundry-vtt-mcp';
const PRODUCT_EXE = 'FoundryVTT MCP Bridge.exe';
const NODE_VERSION = '22.12.0';
const NODE_ARCHIVE = `node-v${NODE_VERSION}-win-x64.zip`;

const installerDir = __dirname;
const repoRoot = path.resolve(installerDir, '..');
const buildDir = path.join(installerDir, 'build');
const stagingDir = path.join(buildDir, 'installer-files');
const payloadDir = path.join(stagingDir, 'payload');
const moduleStageDir = path.join(stagingDir, 'foundry-module');
const desktopPayloadDir = path.join(repoRoot, 'packages', 'desktop', 'release', 'win-unpacked');
const serverDistDir = path.join(repoRoot, 'packages', 'mcp-server', 'dist');
const moduleSourceDir = path.join(repoRoot, 'packages', 'foundry-module');
const nsisSourceDir = path.join(installerDir, 'nsis');

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const options = {
    version: require(path.join(repoRoot, 'package.json')).version,
    skipDownload: false,
    skipNsis: false,
    skipDesktopBuild: false,
    skipServerBuild: false,
    desktopPayload: desktopPayloadDir,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--version') {
      options.version = argv[++index];
    } else if (argument === '--skip-download') {
      options.skipDownload = true;
    } else if (argument === '--skip-nsis') {
      options.skipNsis = true;
    } else if (argument === '--skip-desktop-build') {
      options.skipDesktopBuild = true;
    } else if (argument === '--skip-server-build') {
      options.skipServerBuild = true;
    } else if (argument === '--desktop-payload') {
      options.desktopPayload = path.resolve(argv[++index]);
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  if (!options.version || !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(options.version)) {
    fail(`Invalid installer version: ${options.version}`);
  }
  options.versionLabel = options.version;
  options.version = options.version.replace(/^v/, '');
  if (options.skipDownload && !options.skipNsis) {
    fail('--skip-download is staging-only and cannot be used to compile a release installer');
  }
  if (options.skipServerBuild && !options.skipNsis) {
    fail(
      '--skip-server-build is static-test-only and cannot be used to compile a release installer'
    );
  }
  return options;
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function assertOrdinarySource(source) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    fail(`Refusing to stage a symbolic link or junction: ${source}`);
  }
  if (!stat.isDirectory() && !stat.isFile()) {
    fail(`Refusing unsupported payload object: ${source}`);
  }
  return stat;
}

function copyTree(source, destination) {
  const stat = assertOrdinarySource(source);
  if (stat.isDirectory()) {
    ensureDirectory(destination);
    for (const name of fs.readdirSync(source).sort((left, right) => left.localeCompare(right))) {
      copyTree(path.join(source, name), path.join(destination, name));
    }
    return;
  }
  ensureDirectory(path.dirname(destination));
  fs.copyFileSync(source, destination);
}

function copyRequiredFile(source, destination) {
  if (!fs.existsSync(source) || !assertOrdinarySource(source).isFile()) {
    fail(`Required file is missing: ${source}`);
  }
  ensureDirectory(path.dirname(destination));
  fs.copyFileSync(source, destination);
}

function cleanBuildDirectory() {
  if (path.dirname(buildDir) !== installerDir || path.basename(buildDir) !== 'build') {
    fail(`Refusing to clean unexpected build path: ${buildDir}`);
  }
  if (fs.existsSync(buildDir)) {
    const stat = fs.lstatSync(buildDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail(`Refusing to clean linked or non-directory build path: ${buildDir}`);
    }
    // Keep the verified root directory in place. On Windows another process may
    // temporarily use it as its current directory, which blocks deleting the
    // directory itself even though its build artifacts are not open.
    for (const name of fs.readdirSync(buildDir)) {
      const entry = path.join(buildDir, name);
      const entryStat = fs.lstatSync(entry);
      if (entryStat.isSymbolicLink()) {
        fail(`Refusing to clean a linked installer build entry: ${entry}`);
      }
      try {
        fs.rmSync(entry, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      } catch (error) {
        if (name !== 'node-extracted' || error.code !== 'EPERM') throw error;
        const quarantine = path.join(
          os.tmpdir(),
          `foundry-mcp-stale-node-extracted-${process.pid}-${Date.now()}`
        );
        if (fs.existsSync(quarantine)) fail(`Unexpected cleanup quarantine exists: ${quarantine}`);
        fs.renameSync(entry, quarantine);
        fs.rmSync(quarantine, {
          recursive: true,
          force: true,
          maxRetries: 8,
          retryDelay: 250,
        });
        console.log(`Recovered a locked generated Node extraction through ${quarantine}.`);
      }
    }
  }
  ensureDirectory(stagingDir);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout || ''}${result.stderr || ''}` : '';
    fail(`${command} exited with code ${result.status}${detail}`);
  }
  return result.stdout || '';
}

function runNpm(args) {
  if (process.platform === 'win32') {
    const npmCli = path.join(
      path.dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js'
    );
    if (!fs.existsSync(npmCli)) {
      fail(`npm CLI was not found next to the active Node runtime: ${npmCli}`);
    }
    return run(process.execPath, [npmCli, ...args]);
  }
  return run('npm', args);
}

function ensureVersionConsistency(options) {
  console.log(`Verifying all release manifests match ${options.version}...`);
  run(process.execPath, [
    path.join(repoRoot, 'scripts', 'check-version-consistency.mjs'),
    '--expected',
    options.version,
  ]);
}

function ensureDesktopIcons() {
  console.log('Verifying desktop icon assets and release wiring...');
  run(process.execPath, [path.join(repoRoot, 'scripts', 'check-desktop-icons.mjs')]);
}

function ensureServerBundles(options) {
  if (!options.skipServerBuild) {
    console.log('Building the MCP server bundles...');
    runNpm(['run', 'bundle:server']);
  }
  for (const file of ['index.bundle.cjs', 'backend.bundle.cjs']) {
    const bundle = path.join(serverDistDir, file);
    if (!fs.existsSync(bundle) || !fs.lstatSync(bundle).isFile()) {
      fail(`Required MCP server bundle is missing: ${bundle}`);
    }
  }
}

function ensureDesktopPayload(options) {
  const expectedExe = path.join(options.desktopPayload, PRODUCT_EXE);
  if (options.desktopPayload === desktopPayloadDir && !options.skipDesktopBuild) {
    console.log('Building the Electron Windows directory payload...');
    runNpm(['run', 'pack:win', '--workspace=packages/desktop']);
  } else if (!fs.existsSync(expectedExe)) {
    if (options.desktopPayload !== desktopPayloadDir || options.skipDesktopBuild) {
      fail(`Electron Windows payload is missing ${PRODUCT_EXE}: ${options.desktopPayload}`);
    }
  }
  if (!fs.existsSync(expectedExe)) {
    fail(`electron-builder did not produce the required executable: ${expectedExe}`);
  }
  assertOrdinarySource(options.desktopPayload);
}

function ensureFoundryModuleBuild() {
  console.log('Building the bundled Foundry module...');
  runNpm(['run', 'build', '--workspace=packages/foundry-module']);
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        typeof response.headers.location === 'string'
      ) {
        response.resume();
        download(new URL(response.headers.location, url).toString(), destination)
          .then(resolve)
          .catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download returned HTTP ${response.statusCode}: ${url}`));
        return;
      }
      ensureDirectory(path.dirname(destination));
      const stream = fs.createWriteStream(destination, { flags: 'wx' });
      response.pipe(stream);
      stream.on('finish', () => stream.close(resolve));
      stream.on('error', reject);
    });
    request.on('error', reject);
  });
}

function downloadText(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        typeof response.headers.location === 'string'
      ) {
        response.resume();
        downloadText(new URL(response.headers.location, url).toString())
          .then(resolve)
          .catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download returned HTTP ${response.statusCode}: ${url}`));
        return;
      }
      response.setEncoding('utf8');
      let value = '';
      response.on('data', chunk => {
        value += chunk;
      });
      response.on('end', () => resolve(value));
    });
    request.on('error', reject);
  });
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

async function stageNodeRuntime(options) {
  const runtimeDir = path.join(payloadDir, 'runtime');
  ensureDirectory(runtimeDir);
  if (options.skipDownload) {
    if (
      process.platform === 'win32' &&
      path.basename(process.execPath).toLowerCase() === 'node.exe'
    ) {
      copyRequiredFile(process.execPath, path.join(runtimeDir, 'node.exe'));
      fs.writeFileSync(
        path.join(runtimeDir, 'STAGING_ONLY.txt'),
        `Staging used the developer Node runtime ${process.version}; release builds use pinned Node v${NODE_VERSION}.\n`
      );
    } else {
      fs.writeFileSync(
        path.join(runtimeDir, 'node.exe'),
        `STAGING ONLY - replace with official Node v${NODE_VERSION} win-x64 node.exe\n`
      );
      fs.writeFileSync(
        path.join(runtimeDir, 'STAGING_ONLY.txt'),
        'This cross-platform static staging payload is intentionally not release-installable.\n'
      );
    }
    return;
  }

  console.log(`Downloading and verifying Node.js v${NODE_VERSION}...`);
  const nodeBaseUrl = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const archivePath = path.join(buildDir, NODE_ARCHIVE);
  const checksums = await downloadText(`${nodeBaseUrl}/SHASUMS256.txt`);
  const checksumLine = checksums
    .split(/\r?\n/)
    .find(line => line.trim().endsWith(`  ${NODE_ARCHIVE}`));
  if (!checksumLine) {
    fail(`Official checksum is missing for ${NODE_ARCHIVE}`);
  }
  const expectedHash = checksumLine.trim().split(/\s+/)[0].toLowerCase();
  await download(`${nodeBaseUrl}/${NODE_ARCHIVE}`, archivePath);
  const actualHash = sha256(archivePath);
  if (actualHash !== expectedHash) {
    fail(`Node.js checksum mismatch: expected ${expectedHash}, received ${actualHash}`);
  }

  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-mcp-node-extract-'));
  try {
    const tarCommand = process.platform === 'win32' ? 'tar.exe' : 'tar';
    const nodeArchiveRoot = `node-v${NODE_VERSION}-win-x64`;
    run(tarCommand, [
      '-xf',
      archivePath,
      '-C',
      extractDir,
      `${nodeArchiveRoot}/node.exe`,
      `${nodeArchiveRoot}/LICENSE`,
    ]);
    const nodeRoot = path.join(extractDir, nodeArchiveRoot);
    copyRequiredFile(path.join(nodeRoot, 'node.exe'), path.join(runtimeDir, 'node.exe'));
    copyRequiredFile(path.join(nodeRoot, 'LICENSE'), path.join(runtimeDir, 'LICENSE-node.txt'));
    fs.writeFileSync(
      path.join(runtimeDir, 'node-version.txt'),
      `Node.js v${NODE_VERSION}\n${NODE_ARCHIVE} SHA-256: ${actualHash}\n`
    );
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

function stageServerBundles() {
  const destination = path.join(payloadDir, 'resources', 'server');
  copyRequiredFile(
    path.join(serverDistDir, 'index.bundle.cjs'),
    path.join(destination, 'index.bundle.cjs')
  );
  copyRequiredFile(
    path.join(serverDistDir, 'backend.bundle.cjs'),
    path.join(destination, 'backend.bundle.cjs')
  );
}

function stageInstallerHelpers() {
  const helperDir = path.join(payloadDir, 'resources', 'installer');
  for (const file of [
    'configure-claude.ps1',
    'configure-claude-wrapper.bat',
    'configure-codex.mjs',
    'foundry-module-cleanup.ps1',
    'install-migration.ps1',
    'stop-bridge.ps1',
  ]) {
    copyRequiredFile(path.join(nsisSourceDir, file), path.join(helperDir, file));
  }
  copyRequiredFile(path.join(nsisSourceDir, 'README.txt'), path.join(payloadDir, 'README.txt'));
  copyRequiredFile(path.join(nsisSourceDir, 'LICENSE.txt'), path.join(payloadDir, 'LICENSE.txt'));
  copyRequiredFile(
    path.join(repoRoot, 'packages', 'desktop', 'THIRD_PARTY_NOTICES.md'),
    path.join(payloadDir, 'THIRD_PARTY_NOTICES.md')
  );
  fs.writeFileSync(path.join(payloadDir, 'foundry-vtt-mcp-bridge.install-id'), `${PRODUCT_ID}\n`);
}

function stageFoundryModule() {
  const mappings = [
    ['dist', 'dist'],
    ['lang', 'lang'],
    ['scripts', 'scripts'],
    ['styles', 'styles'],
    ['templates', 'templates'],
    ['module.json', 'module.json'],
  ];
  for (const [sourceName, destinationName] of mappings) {
    const source = path.join(moduleSourceDir, sourceName);
    if (!fs.existsSync(source)) {
      if (sourceName === 'module.json' || sourceName === 'dist') {
        fail(`Required Foundry module build output is missing: ${source}`);
      }
      continue;
    }
    copyTree(source, path.join(moduleStageDir, destinationName));
  }
}

function listFilesRecursively(root, current = root) {
  const files = [];
  for (const name of fs.readdirSync(current).sort((left, right) => left.localeCompare(right))) {
    const absolute = path.join(current, name);
    const stat = assertOrdinarySource(absolute);
    if (stat.isDirectory()) {
      files.push(...listFilesRecursively(root, absolute));
    } else {
      files.push(path.relative(root, absolute).split(path.sep).join('\\'));
    }
  }
  return files;
}

function writeOwnedManifest(version) {
  const manifestName = 'installer-owned-files.json';
  const manifestPath = path.join(payloadDir, manifestName);
  const files = listFilesRecursively(payloadDir).filter(file => file !== manifestName);
  files.push(manifestName);
  files.sort((left, right) => left.localeCompare(right));
  const manifest = {
    schemaVersion: 1,
    productId: PRODUCT_ID,
    version,
    files,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function directorySize(directory) {
  return listFilesRecursively(directory).reduce(
    (sum, relative) => sum + fs.statSync(path.join(directory, ...relative.split('\\'))).size,
    0
  );
}

function windowsVersion(version) {
  const core = version.split(/[-+]/, 1)[0].split('.');
  while (core.length < 4) core.push('0');
  return core.slice(0, 4).join('.');
}

function findMakeNsis() {
  const candidates = [
    process.env.MAKENSIS,
    'makensis',
    'makensis.exe',
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'NSIS', 'makensis.exe'),
    process.env['ProgramFiles(x86)'] &&
      path.join(process.env['ProgramFiles(x86)'], 'NSIS', 'makensis.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['/VERSION'], {
      encoding: 'utf8',
      stdio: 'pipe',
      windowsHide: true,
    });
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

function compileInstaller(options, estimatedSizeKb) {
  const makeNsis = findMakeNsis();
  if (!makeNsis) {
    fail('NSIS makensis was not found. Install NSIS or set MAKENSIS to its absolute path.');
  }
  const outputPath = path.join(buildDir, `FoundryVTT-MCP-Bridge-Setup-${options.versionLabel}.exe`);
  run(
    makeNsis,
    [
      '/V4',
      `/DVERSION=${options.version}`,
      `/DPRODUCT_VERSION=${windowsVersion(options.version)}`,
      `/DESTIMATED_SIZE_KB=${estimatedSizeKb}`,
      `/DOUTFILE=${outputPath}`,
      path.join(nsisSourceDir, 'foundry-mcp-server.nsi'),
    ],
    { cwd: stagingDir }
  );
  if (!fs.existsSync(outputPath)) {
    fail(`NSIS reported success but did not create ${outputPath}`);
  }
  console.log(`Installer created: ${outputPath}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  console.log(`Staging Foundry VTT MCP Bridge ${options.version}`);
  ensureVersionConsistency(options);
  ensureDesktopIcons();
  cleanBuildDirectory();
  ensureServerBundles(options);
  ensureDesktopPayload(options);
  ensureFoundryModuleBuild();
  copyTree(options.desktopPayload, payloadDir);
  stageServerBundles();
  await stageNodeRuntime(options);
  stageInstallerHelpers();
  stageFoundryModule();

  copyRequiredFile(
    path.join(repoRoot, 'packages', 'desktop', 'assets', 'app-icon.ico'),
    path.join(stagingDir, 'icon.ico')
  );
  copyRequiredFile(path.join(nsisSourceDir, 'LICENSE.txt'), path.join(stagingDir, 'LICENSE.txt'));
  copyRequiredFile(path.join(nsisSourceDir, 'README.txt'), path.join(stagingDir, 'README.txt'));
  writeOwnedManifest(options.version);

  const estimatedSizeKb = Math.max(1, Math.ceil(directorySize(payloadDir) / 1024));
  const stagedExe = path.join(payloadDir, PRODUCT_EXE);
  if (!fs.existsSync(stagedExe)) fail(`Staged application executable is missing: ${stagedExe}`);
  console.log(
    `Staged ${listFilesRecursively(payloadDir).length} application files (${estimatedSizeKb} KiB).`
  );

  if (options.skipNsis) {
    console.log('NSIS compilation skipped; staged payload is static-test only.');
    return;
  }
  compileInstaller(options, estimatedSizeKb);
}

main().catch(error => {
  console.error(`Installer build failed: ${error.message}`);
  process.exitCode = 1;
});
