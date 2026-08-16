#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const desktopRoot = path.join(repositoryRoot, 'packages', 'desktop');
const assetsRoot = path.join(desktopRoot, 'assets');
const generatedRoot = path.join(assetsRoot, 'generated');
const manifestFile = path.join(generatedRoot, 'icon-manifest.json');

const EXPECTED_DESIGN_ID = 'foundry-d20-network-topology-v3';
const EXPECTED_VENDOR_SHA256 = '6D0156A49AAF82836245F54AEB9BBF80F8B4FFFFCE67ACCE7FB029CCC14558CC';
const EXPECTED_APP_SIZES = [16, 20, 24, 32, 40, 48, 256, 512, 1024];
const EXPECTED_ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const EXPECTED_TRAY_SIZES = [16, 20, 24, 32, 40, 48];
const EXPECTED_STATES = ['connected', 'waiting', 'error'];

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex').toUpperCase();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertArrayEqual(actual, expected, message) {
  assert(
    Array.isArray(actual) && actual.join(',') === expected.join(','),
    `${message}: expected ${expected.join(', ')}, got ${String(actual)}`
  );
}

async function listFiles(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, child)));
    else if (entry.isFile()) files.push(child.split(path.sep).join('/'));
    else throw new Error(`Generated icon inventory contains a non-regular entry: ${child}`);
  }
  return files.sort();
}

async function verifyPng(buffer, width, height, label, requireTransparentEdge = true) {
  const metadata = await sharp(buffer).metadata();
  assert(metadata.format === 'png', `${label} is not PNG encoded`);
  assert(metadata.width === width && metadata.height === height, `${label} dimensions changed`);
  assert(metadata.hasAlpha === true, `${label} has no alpha channel`);
  if (!requireTransparentEdge) return;

  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3];
  for (let index = 0; index < info.width; index += 1) {
    assert(alphaAt(index, 0) === 0, `${label} top edge is not transparent`);
    assert(alphaAt(index, info.height - 1) === 0, `${label} bottom edge is not transparent`);
  }
  for (let index = 1; index < info.height - 1; index += 1) {
    assert(alphaAt(0, index) === 0, `${label} left edge is not transparent`);
    assert(alphaAt(info.width - 1, index) === 0, `${label} right edge is not transparent`);
  }
}

async function verifyIco(buffer) {
  assert(buffer.length >= 6, 'Windows ICO is truncated');
  assert(buffer.readUInt16LE(0) === 0, 'Windows ICO reserved header is invalid');
  assert(buffer.readUInt16LE(2) === 1, 'Windows ICO type is invalid');
  const count = buffer.readUInt16LE(4);
  assert(count === EXPECTED_ICO_SIZES.length, 'Windows ICO frame count changed');
  const directoryEnd = 6 + count * 16;
  const sizes = [];
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  for (let index = 0; index < count; index += 1) {
    const entryOffset = 6 + index * 16;
    const width = buffer.readUInt8(entryOffset) || 256;
    const height = buffer.readUInt8(entryOffset + 1) || 256;
    const planes = buffer.readUInt16LE(entryOffset + 4);
    const bitsPerPixel = buffer.readUInt16LE(entryOffset + 6);
    const length = buffer.readUInt32LE(entryOffset + 8);
    const offset = buffer.readUInt32LE(entryOffset + 12);
    assert(width === height, `Windows ICO frame ${index} is not square`);
    assert(planes === 1 && bitsPerPixel === 32, `Windows ICO frame ${width}px is not RGBA`);
    assert(
      offset >= directoryEnd && offset + length <= buffer.length,
      `ICO ${width}px bounds invalid`
    );
    const payload = buffer.subarray(offset, offset + length);
    assert(
      payload.subarray(0, pngSignature.length).equals(pngSignature),
      `ICO ${width}px is not PNG`
    );
    await verifyPng(payload, width, height, `ICO ${width}px frame`);
    sizes.push(width);
  }
  assertArrayEqual(sizes, EXPECTED_ICO_SIZES, 'Windows ICO sizes changed');
  return sizes;
}

async function verifyFileHash(file, expectedHash, label) {
  const buffer = await readFile(file);
  const actualHash = sha256(buffer);
  assert(
    actualHash === expectedHash,
    `${label} is stale: expected ${expectedHash}, got ${actualHash}`
  );
  return buffer;
}

async function assertRegularFile(file, label) {
  const stats = await lstat(file);
  assert(stats.isFile() && !stats.isSymbolicLink(), `${label} is not a regular file`);
}

async function assertMissing(file, label) {
  try {
    await lstat(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${label} must not exist`);
}

async function verifyManifest(manifest) {
  assert(manifest.schemaVersion === 1, 'Icon manifest schema changed');
  assert(manifest.design?.id === EXPECTED_DESIGN_ID, 'Unexpected desktop icon design id');
  assertArrayEqual(
    manifest.design?.foundationOnlySizes,
    [16, 20, 24, 32],
    'Foundation-only size policy changed'
  );
  assertArrayEqual(manifest.design?.topologySizes, [40, 48], 'Topology size policy changed');
  assert(manifest.source?.sha256 === EXPECTED_VENDOR_SHA256, 'Official source hash changed');

  const sourceEntries = [manifest.source, manifest.design.glyph, manifest.design.background];
  for (const entry of sourceEntries) {
    const file = path.resolve(assetsRoot, entry.file);
    await assertRegularFile(file, `Icon source ${entry.file}`);
    await verifyFileHash(file, entry.sha256, `Icon source ${entry.file}`);
  }
  const generatorFile = path.resolve(assetsRoot, manifest.design.generator.file);
  assert(
    generatorFile === path.join(repositoryRoot, 'scripts', 'build-desktop-icons.mjs'),
    'Generator path escaped its expected location'
  );
  await verifyFileHash(generatorFile, manifest.design.generator.sha256, 'Icon generator');

  const outputFiles = new Set();
  for (const entry of manifest.outputs) {
    assert(!outputFiles.has(entry.file), `Duplicate manifest output ${entry.file}`);
    outputFiles.add(entry.file);
    const file = path.resolve(generatedRoot, entry.file);
    assert(
      file.startsWith(`${path.resolve(generatedRoot)}${path.sep}`),
      `Output path escaped: ${entry.file}`
    );
    await assertRegularFile(file, `Generated output ${entry.file}`);
    const buffer = await verifyFileHash(file, entry.sha256, `Generated output ${entry.file}`);
    if (entry.file.endsWith('.png')) {
      await verifyPng(
        buffer,
        entry.width,
        entry.height,
        `Generated output ${entry.file}`,
        entry.file !== 'icon-preview.png'
      );
    } else if (entry.file.endsWith('.ico')) {
      assertArrayEqual(await verifyIco(buffer), entry.sizes, 'ICO manifest sizes changed');
    } else {
      throw new Error(`Unsupported generated icon output: ${entry.file}`);
    }
  }

  const actualFiles = await listFiles(generatedRoot);
  const expectedFiles = [...outputFiles, 'icon-manifest.json'].sort();
  assertArrayEqual(actualFiles, expectedFiles, 'Generated icon inventory changed');

  const appSizes = manifest.outputs
    .filter(entry => /^app\/app-icon-\d+\.png$/.test(entry.file))
    .map(entry => entry.width)
    .sort((left, right) => left - right);
  assertArrayEqual(appSizes, EXPECTED_APP_SIZES, 'App PNG sizes changed');
  for (const state of EXPECTED_STATES) {
    const sizes = manifest.outputs
      .filter(entry => new RegExp(`^tray/tray-${state}-\\d+\\.png$`).test(entry.file))
      .map(entry => entry.width)
      .sort((left, right) => left - right);
    assertArrayEqual(sizes, EXPECTED_TRAY_SIZES, `Tray ${state} sizes changed`);
  }
}

async function verifyRuntimeAliases(manifest) {
  const canonicalFiles = {
    'app-icon.ico': 'app/app-icon.ico',
    'app-icon.png': 'app/app-icon.png',
    'tray-icon-connected.png': 'tray/tray-connected.png',
    'tray-icon-connected@2x.png': 'tray/tray-connected@2x.png',
    'tray-icon-error.png': 'tray/tray-error.png',
    'tray-icon-error@2x.png': 'tray/tray-error@2x.png',
    'tray-icon-waiting.png': 'tray/tray-waiting.png',
    'tray-icon-waiting@2x.png': 'tray/tray-waiting@2x.png',
    'tray-icon.png': 'tray/tray-connected.png',
    'tray-icon@2x.png': 'tray/tray-connected@2x.png',
  };
  for (const state of EXPECTED_STATES) {
    for (const size of EXPECTED_TRAY_SIZES) {
      canonicalFiles[`tray-icon-${state}-${size}.png`] = `tray/tray-${state}-${size}.png`;
    }
  }
  assertArrayEqual(
    manifest.runtimeAliases.map(entry => entry.file).sort(),
    Object.keys(canonicalFiles).sort(),
    'Runtime alias inventory changed'
  );
  const actualAliasFiles = (await readdir(assetsRoot, { withFileTypes: true }))
    .filter(
      entry =>
        entry.isFile() &&
        (entry.name === 'app-icon.ico' ||
          entry.name === 'app-icon.png' ||
          /^tray-icon.*\.png$/.test(entry.name))
    )
    .map(entry => entry.name)
    .sort();
  assertArrayEqual(
    actualAliasFiles,
    Object.keys(canonicalFiles).sort(),
    'On-disk runtime alias inventory changed'
  );

  for (const entry of manifest.runtimeAliases) {
    const aliasFile = path.join(assetsRoot, entry.file);
    const canonicalFile = path.join(generatedRoot, canonicalFiles[entry.file]);
    await assertRegularFile(aliasFile, `Runtime alias ${entry.file}`);
    const [alias, canonical] = await Promise.all([readFile(aliasFile), readFile(canonicalFile)]);
    assert(
      alias.equals(canonical),
      `Runtime alias ${entry.file} differs from its canonical output`
    );
    assert(sha256(alias) === entry.sha256, `Runtime alias ${entry.file} hash is stale`);
    if (entry.file.endsWith('.png')) {
      await verifyPng(alias, entry.width, entry.height, `Runtime alias ${entry.file}`);
    } else {
      assertArrayEqual(
        await verifyIco(alias),
        entry.sizes,
        `Runtime alias ${entry.file} sizes changed`
      );
    }
  }
}

function assertContains(source, expected, label) {
  assert(source.includes(expected), `${label} is not wired to ${expected}`);
}

async function verifyResourceWiring(manifest) {
  const [
    mainSource,
    trayIconSource,
    buildSource,
    desktopPackage,
    rootPackage,
    installerSource,
    nsisSource,
    glyphSource,
    releaseWorkflow,
    qualityWorkflow,
  ] = await Promise.all([
    readFile(path.join(desktopRoot, 'src', 'main', 'main.ts'), 'utf8'),
    readFile(path.join(desktopRoot, 'src', 'main', 'tray-icons.ts'), 'utf8'),
    readFile(path.join(desktopRoot, 'scripts', 'build.mjs'), 'utf8'),
    readFile(path.join(desktopRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(repositoryRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(repositoryRoot, 'installer', 'build-nsis.js'), 'utf8'),
    readFile(path.join(repositoryRoot, 'installer', 'nsis', 'foundry-mcp-server.nsi'), 'utf8'),
    readFile(path.join(assetsRoot, 'brand', 'mcp-bridge-glyph.svg'), 'utf8'),
    readFile(
      path.join(repositoryRoot, '.github', 'workflows', 'build-complete-release.yml'),
      'utf8'
    ),
    readFile(path.join(repositoryRoot, '.github', 'workflows', 'quality-gates.yml'), 'utf8'),
  ]);

  assert(!/<text\b/i.test(glyphSource), 'Text is forbidden in the bridge glyph');
  await assertMissing(path.join(assetsRoot, 'brand', 'mcp-badge.svg'), 'Retired MCP text badge');
  const appIconExpression =
    "assetPath(process.platform === 'win32' ? 'app-icon.ico' : 'app-icon.png')";
  assert(
    mainSource.split(appIconExpression).length - 1 >= 2,
    'Window/About app icons are not wired'
  );
  assertContains(mainSource, 'createMultiRepresentationTrayIcon', 'Electron tray loader');
  const compactMainSource = mainSource.replace(/\s+/g, ' ');
  assertContains(
    trayIconSource,
    'export const TRAY_ICON_SIZES = [16, 20, 24, 32, 40, 48] as const',
    'Tray physical-size policy'
  );
  assertContains(trayIconSource, 'image.addRepresentation', 'Tray NativeImage representations');
  assertContains(trayIconSource, 'image.getScaleFactors()', 'Tray NativeImage verification');
  assertContains(trayIconSource, 'scaleFactor:', 'Tray representation scale factors');
  for (const state of EXPECTED_STATES) {
    assertContains(
      compactMainSource,
      `createMultiRepresentationTrayIcon(assetsDirectory, '${state}', nativeImage)`,
      `Electron tray ${state} NativeImage`
    );
    for (const size of EXPECTED_TRAY_SIZES) {
      assertContains(
        JSON.stringify(manifest.runtimeAliases),
        `tray-icon-${state}-${size}.png`,
        `Tray ${state} ${size}px runtime representation`
      );
    }
  }
  assertContains(buildSource, "path.join(packageRoot, 'assets')", 'Desktop asset copy');
  assertContains(buildSource, "path.join(outputRoot, 'assets')", 'Desktop dist asset copy');
  assert(
    desktopPackage.build?.win?.icon === 'assets/app-icon.ico',
    'electron-builder Windows icon changed'
  );
  assert(
    desktopPackage.build?.mac?.icon === 'assets/app-icon.png',
    'electron-builder macOS icon changed'
  );
  assertContains(installerSource, "'assets', 'app-icon.ico'", 'NSIS staging source');
  assertContains(installerSource, "path.join(stagingDir, 'icon.ico')", 'NSIS staged icon');
  assertContains(nsisSource, '!define MUI_ICON "${STAGE_DIR}\\icon.ico"', 'NSIS installer icon');
  assertContains(
    nsisSource,
    '!define MUI_UNICON "${STAGE_DIR}\\icon.ico"',
    'NSIS uninstaller icon'
  );
  assert(
    rootPackage.scripts?.test?.startsWith('npm run test:desktop-icons &&'),
    'Default test command does not gate desktop icons'
  );
  assertContains(
    desktopPackage.scripts?.prebuild ?? '',
    '../../scripts/check-desktop-icons.mjs',
    'Desktop build/package gate'
  );
  assertContains(installerSource, 'function ensureDesktopIcons()', 'Installer icon gate');
  assertContains(
    installerSource,
    "'scripts', 'check-desktop-icons.mjs'",
    'Installer icon verifier'
  );
  assertContains(releaseWorkflow, 'run: npm test', 'Complete release quality gate');
  assertContains(qualityWorkflow, 'run: npm test', 'Quality workflow icon gate');
}

async function main() {
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  await verifyManifest(manifest);
  await verifyRuntimeAliases(manifest);
  await verifyResourceWiring(manifest);
  console.log(`Desktop icon design: ${manifest.design.id}`);
  console.log(
    `Verified ${manifest.outputs.length} outputs and ${manifest.runtimeAliases.length} aliases`
  );
  console.log(`Official Foundry source unchanged: ${EXPECTED_VENDOR_SHA256}`);
  console.log(`Windows ICO frames: ${EXPECTED_ICO_SIZES.join(', ')}`);
  console.log(`Tray NativeImage representations: ${EXPECTED_TRAY_SIZES.join(', ')}`);
  console.log('Electron, electron-builder, and NSIS icon wiring verified');
  console.log('Default test, desktop prebuild/package, and installer icon gates verified');
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
