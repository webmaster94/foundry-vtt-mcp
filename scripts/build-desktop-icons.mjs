#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const scriptFile = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptFile);
const repositoryRoot = path.resolve(scriptDirectory, '..');
const desktopRoot = path.join(repositoryRoot, 'packages', 'desktop');
const assetsRoot = path.join(desktopRoot, 'assets');
const vendorAsset = path.join(assetsRoot, 'vendor', 'foundry', 'fvtt-d20.png');
const backgroundAsset = path.join(assetsRoot, 'brand', 'app-icon-background.svg');
const bridgeGlyphAsset = path.join(assetsRoot, 'brand', 'mcp-bridge-glyph.svg');
const outputRoot = path.join(assetsRoot, 'generated');
const appOutputRoot = path.join(outputRoot, 'app');
const trayOutputRoot = path.join(outputRoot, 'tray');

const EXPECTED_VENDOR_SHA256 = '6D0156A49AAF82836245F54AEB9BBF80F8B4FFFFCE67ACCE7FB029CCC14558CC';
const MASTER_SIZE = 1024;
const APP_PNG_SIZES = [16, 20, 24, 32, 40, 48, 256, 512, 1024];
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const TRAY_SIZES = [16, 20, 24, 32, 40, 48];
const PNG_OPTIONS = {
  compressionLevel: 9,
  adaptiveFiltering: false,
  palette: false,
  force: true,
};

const trayStates = {
  connected: { color: '#2ED88F', rgb: [46, 216, 143], glyph: 'check' },
  waiting: { color: '#FFC857', rgb: [255, 200, 87], glyph: 'pause' },
  error: { color: '#FF5B5B', rgb: [255, 91, 91], glyph: 'cross' },
};

const smallAppGeometry = {
  16: { bridge: false, x: 1, y: 8, width: 9, height: 6, stroke: 1.1, port: 2 },
  20: { bridge: false, x: 1, y: 11, width: 11, height: 7, stroke: 1.3, port: 2.25 },
  24: { bridge: false, x: 2, y: 14, width: 13, height: 8, stroke: 1.5, port: 2.5 },
  32: { bridge: false, x: 2, y: 19, width: 17, height: 11, stroke: 2, port: 3 },
  40: { x: 3, y: 25, width: 21, height: 13, stroke: 2.5, port: 4 },
  48: { x: 3, y: 30, width: 25, height: 16, stroke: 3, port: 4.5 },
};

const smallTrayGeometry = {
  16: { bridge: false, x: 1, y: 9, width: 8, height: 5, stroke: 1, port: 1.8, state: 6 },
  20: { bridge: false, x: 1, y: 12, width: 10, height: 6, stroke: 1.2, port: 2, state: 7 },
  24: { bridge: false, x: 1, y: 14, width: 13, height: 8, stroke: 1.5, port: 2.4, state: 8 },
  32: { bridge: false, x: 2, y: 20, width: 18, height: 10, stroke: 2, port: 3, state: 10 },
  40: { x: 2, y: 25, width: 24, height: 13, stroke: 2.5, port: 3.8, state: 12 },
  48: { x: 3, y: 31, width: 29, height: 15, stroke: 3, port: 4.4, state: 14 },
};

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex').toUpperCase();
}

function assertSafeOutputPath(candidate) {
  const resolvedDesktopRoot = path.resolve(desktopRoot) + path.sep;
  const resolvedCandidate = path.resolve(candidate);
  if (
    !resolvedCandidate.startsWith(resolvedDesktopRoot) ||
    path.basename(resolvedCandidate) !== 'generated'
  ) {
    throw new Error(`Refusing to replace unsafe generated-assets path: ${resolvedCandidate}`);
  }
}

function smallBridgeOverlaySvg(size, geometry) {
  const leftX = geometry.x + geometry.width * 0.2;
  const centerX = geometry.x + geometry.width * 0.5;
  const rightX = geometry.x + geometry.width * 0.8;
  const upperY = geometry.y + geometry.height * 0.27;
  const lowerY = geometry.y + geometry.height * 0.72;
  const outline = size >= 24 ? 1 : 0;
  const upperRing = size >= 24 ? Math.min(1, geometry.port * 0.28) : 0;

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <rect x="${geometry.x + outline / 2}" y="${geometry.y + outline / 2}" width="${geometry.width - outline}" height="${geometry.height - outline}" rx="${geometry.height * 0.26}" fill="#071015" stroke="#FF6A2A" stroke-width="${outline}"/>
      <path d="M${leftX} ${lowerY}L${centerX} ${upperY}L${rightX} ${lowerY}" fill="none" stroke="#FFF4EA" stroke-width="${geometry.stroke}" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${leftX}" cy="${lowerY}" r="${geometry.port / 2}" fill="#FFF4EA"/>
      <circle cx="${rightX}" cy="${lowerY}" r="${geometry.port / 2}" fill="#FFF4EA"/>
      <circle cx="${centerX}" cy="${upperY}" r="${geometry.port / 2}" fill="#FF6A2A" stroke="#FFF4EA" stroke-width="${upperRing}"/>
    </svg>`
  );
}

function smallStateOverlaySvg(size, definition, diameter) {
  const x = size - diameter - 2;
  const y = size - diameter - 2;
  const centerX = x + diameter / 2;
  const centerY = y + diameter / 2;
  const markStroke = Math.max(1, diameter * 0.17);
  const glyphMarkup =
    definition.glyph === 'check'
      ? `<path d="M${x + diameter * 0.2} ${y + diameter * 0.52}L${x + diameter * 0.42} ${y + diameter * 0.75}L${x + diameter * 0.8} ${y + diameter * 0.25}" fill="none" stroke="#071015" stroke-width="${markStroke}" stroke-linecap="round" stroke-linejoin="round"/>`
      : definition.glyph === 'pause'
        ? `<path d="M${x + diameter * 0.38} ${y + diameter * 0.25}V${y + diameter * 0.75}M${x + diameter * 0.64} ${y + diameter * 0.25}V${y + diameter * 0.75}" fill="none" stroke="#071015" stroke-width="${markStroke}" stroke-linecap="round"/>`
        : `<path d="M${x + diameter * 0.25} ${y + diameter * 0.25}L${x + diameter * 0.75} ${y + diameter * 0.75}M${x + diameter * 0.75} ${y + diameter * 0.25}L${x + diameter * 0.25} ${y + diameter * 0.75}" fill="none" stroke="#071015" stroke-width="${markStroke}" stroke-linecap="round"/>`;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${centerX}" cy="${centerY}" r="${diameter / 2}" fill="${definition.color}" stroke="#E8EEF2" stroke-width="${size >= 24 ? 1 : 0}"/>
      ${glyphMarkup}
    </svg>`
  );
}

async function resizePng(input, size) {
  // Lanczos resampling can introduce a one-alpha fringe at the outermost
  // pixel of tiny images. Reserve one explicit transparent pixel around
  // Windows shell sizes so tray and ICO corners remain genuinely clear.
  const transparentBorder = size <= 64 ? 1 : 0;
  const contentSize = size - transparentBorder * 2;
  let pipeline = sharp(input, { density: 384 }).resize(contentSize, contentSize, {
    fit: 'fill',
    kernel: sharp.kernel.lanczos3,
  });
  if (transparentBorder > 0) {
    pipeline = pipeline.extend({
      top: transparentBorder,
      right: transparentBorder,
      bottom: transparentBorder,
      left: transparentBorder,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
  }
  return pipeline.png(PNG_OPTIONS).toBuffer();
}

async function verifyTransparentPng(buffer, expectedSize, label) {
  const metadata = await sharp(buffer).metadata();
  if (
    metadata.format !== 'png' ||
    metadata.width !== expectedSize ||
    metadata.height !== expectedSize ||
    metadata.hasAlpha !== true
  ) {
    throw new Error(`${label} is not a ${expectedSize}x${expectedSize} transparent PNG`);
  }

  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3];
  const edgeAlpha = [];
  for (let index = 0; index < info.width; index += 1) {
    edgeAlpha.push(alphaAt(index, 0), alphaAt(index, info.height - 1));
  }
  for (let index = 1; index < info.height - 1; index += 1) {
    edgeAlpha.push(alphaAt(0, index), alphaAt(info.width - 1, index));
  }
  if (edgeAlpha.some(alpha => alpha !== 0)) {
    throw new Error(`${label} has a nontransparent outer row or column`);
  }
}

async function renderSmallShellIcon(foundation, size, geometry, state = null) {
  const base = await resizePng(foundation, size);
  const overlays = [];
  if (geometry.bridge !== false) {
    overlays.push({ input: smallBridgeOverlaySvg(size, geometry), left: 0, top: 0 });
  }
  if (state) {
    overlays.push({
      input: smallStateOverlaySvg(size, state, geometry.state),
      left: 0,
      top: 0,
    });
  }
  return overlays.length === 0 ? base : sharp(base).composite(overlays).png(PNG_OPTIONS).toBuffer();
}

async function verifySmallIconLegibility(buffer, size, label, stateRgb = null, geometry = null) {
  if (size > 48) return;
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let visiblePixels = 0;
  let logoOrangePixels = 0;
  let bridgeLightPixels = 0;
  let bridgeOrangePixels = 0;
  let statePixels = 0;
  let bridgePeakLightness = 0;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const alpha = data[offset + 3];
      if (alpha >= 96) visiblePixels += 1;

      const warm = alpha >= 96 && red >= 150 && red >= green * 1.3 && blue <= 125;
      if (warm && y < size * 0.72) logoOrangePixels += 1;
      if (warm && x < size * 0.72 && y > size * 0.56) bridgeOrangePixels += 1;
      if (x < size * 0.72 && y > size * 0.56) {
        bridgePeakLightness = Math.max(bridgePeakLightness, Math.min(red, green, blue));
        if (alpha >= 96 && red >= 132 && green >= 132 && blue >= 132) {
          bridgeLightPixels += 1;
        }
      }

      if (stateRgb && x > size * 0.67 && y > size * 0.65 && alpha >= 96) {
        const distance = Math.hypot(red - stateRgb[0], green - stateRgb[1], blue - stateRgb[2]);
        if (distance < 105) statePixels += 1;
      }
    }
  }

  const totalPixels = size * size;
  if (visiblePixels < totalPixels * 0.32 || visiblePixels > totalPixels * 0.9) {
    throw new Error(`${label} has unsuitable visible coverage at ${size}px: ${visiblePixels}`);
  }
  const minimumDetailPixels = Math.max(1, Math.floor(size / 16));
  if (logoOrangePixels < minimumDetailPixels) {
    throw new Error(`${label} lost the Foundry orange silhouette at ${size}px`);
  }
  const requireBridge = geometry?.bridge !== false;
  if (
    requireBridge &&
    (bridgeLightPixels < minimumDetailPixels || bridgeOrangePixels < minimumDetailPixels)
  ) {
    throw new Error(
      `${label} lost the text-free MCP bridge mark at ${size}px ` +
        `(light=${bridgeLightPixels}, orange=${bridgeOrangePixels}, peak=${bridgePeakLightness})`
    );
  }
  if (stateRgb && statePixels < minimumDetailPixels) {
    throw new Error(`${label} lost its connection-state color at ${size}px`);
  }

  if (geometry && geometry.bridge !== false) {
    const pixelMatchesNear = (centerX, centerY, radius, predicate) => {
      const startX = Math.max(0, Math.floor(centerX - radius));
      const endX = Math.min(size - 1, Math.ceil(centerX + radius));
      const startY = Math.max(0, Math.floor(centerY - radius));
      const endY = Math.min(size - 1, Math.ceil(centerY + radius));
      for (let y = startY; y <= endY; y += 1) {
        for (let x = startX; x <= endX; x += 1) {
          const offset = (y * info.width + x) * info.channels;
          if (predicate(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])) {
            return true;
          }
        }
      }
      return false;
    };
    const light = (red, green, blue, alpha) =>
      alpha >= 96 && red >= 125 && green >= 125 && blue >= 125;
    const warm = (red, green, blue, alpha) =>
      alpha >= 96 && red >= 145 && red >= green * 1.2 && blue <= 140;
    const left = {
      x: geometry.x + geometry.width * 0.2,
      y: geometry.y + geometry.height * 0.72,
    };
    const upper = {
      x: geometry.x + geometry.width * 0.5,
      y: geometry.y + geometry.height * 0.27,
    };
    const right = {
      x: geometry.x + geometry.width * 0.8,
      y: geometry.y + geometry.height * 0.72,
    };
    const nodeRadius = Math.max(1, geometry.port * 0.65);
    const linkRadius = Math.max(1, geometry.stroke * 0.6);
    const leftMidpoint = { x: (left.x + upper.x) / 2, y: (left.y + upper.y) / 2 };
    const rightMidpoint = { x: (right.x + upper.x) / 2, y: (right.y + upper.y) / 2 };
    const topologyChecks = [
      ['left port', left.x, left.y, nodeRadius, light],
      ['upper port', upper.x, upper.y, nodeRadius, warm],
      ['right port', right.x, right.y, nodeRadius, light],
      ['left link', leftMidpoint.x, leftMidpoint.y, linkRadius, light],
      ['right link', rightMidpoint.x, rightMidpoint.y, linkRadius, light],
    ];
    for (const [part, x, y, radius, predicate] of topologyChecks) {
      if (!pixelMatchesNear(x, y, radius, predicate)) {
        throw new Error(`${label} lost its ${part} at ${size}px`);
      }
    }
    if (left.y - upper.y < 2 || right.x - left.x < 4) {
      throw new Error(`${label} topology geometry is too compressed at ${size}px`);
    }
  }
}

async function stateMarkSignature(buffer, size, geometry) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const diameter = geometry.state;
  const start = size - diameter - 2;
  const mask = [];
  for (let y = start; y < start + diameter; y += 1) {
    for (let x = start; x < start + diameter; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const dark =
        data[offset + 3] >= 96 &&
        data[offset] <= 80 &&
        data[offset + 1] <= 80 &&
        data[offset + 2] <= 80;
      mask.push(dark ? 1 : 0);
    }
  }
  return sha256(Buffer.from(mask));
}

function makeIco(images) {
  if (images.length === 0 || images.length > 255) {
    throw new Error(`Invalid ICO image count: ${images.length}`);
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(images.length * 16);
  let imageOffset = header.length + directory.length;

  for (const [index, image] of images.entries()) {
    const entryOffset = index * 16;
    directory.writeUInt8(image.size === 256 ? 0 : image.size, entryOffset);
    directory.writeUInt8(image.size === 256 ? 0 : image.size, entryOffset + 1);
    directory.writeUInt8(0, entryOffset + 2);
    directory.writeUInt8(0, entryOffset + 3);
    directory.writeUInt16LE(1, entryOffset + 4);
    directory.writeUInt16LE(32, entryOffset + 6);
    directory.writeUInt32LE(image.buffer.length, entryOffset + 8);
    directory.writeUInt32LE(imageOffset, entryOffset + 12);
    imageOffset += image.buffer.length;
  }

  return Buffer.concat([header, directory, ...images.map(image => image.buffer)]);
}

function readIcoSizes(buffer) {
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error('Generated ICO has an invalid header');
  }
  const count = buffer.readUInt16LE(4);
  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = 6 + index * 16;
    const width = buffer.readUInt8(entryOffset) || 256;
    const height = buffer.readUInt8(entryOffset + 1) || 256;
    if (width !== height)
      throw new Error(`Generated ICO contains a non-square ${width}x${height} frame`);
    sizes.push(width);
  }
  return sizes;
}

function verifyIcoPayload(buffer, images) {
  if (buffer.readUInt16LE(4) !== images.length) {
    throw new Error('Generated ICO frame count does not match its source frames');
  }
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const [index, image] of images.entries()) {
    const entryOffset = 6 + index * 16;
    const planes = buffer.readUInt16LE(entryOffset + 4);
    const bitsPerPixel = buffer.readUInt16LE(entryOffset + 6);
    const length = buffer.readUInt32LE(entryOffset + 8);
    const offset = buffer.readUInt32LE(entryOffset + 12);
    if (planes !== 1 || bitsPerPixel !== 32) {
      throw new Error(`Generated ICO frame ${image.size}px is not 32-bit RGBA`);
    }
    if (offset < 6 + images.length * 16 || offset + length > buffer.length) {
      throw new Error(`Generated ICO frame ${image.size}px has invalid payload bounds`);
    }
    const payload = buffer.subarray(offset, offset + length);
    if (!payload.subarray(0, pngSignature.length).equals(pngSignature)) {
      throw new Error(`Generated ICO frame ${image.size}px is not PNG encoded`);
    }
    if (!payload.equals(image.buffer)) {
      throw new Error(`Generated ICO frame ${image.size}px differs from its verified source`);
    }
  }
}

async function renderPreviewSheet() {
  const tileSize = 144;
  const gap = 8;
  const inset = 16;
  const displayedIconSize = tileSize - inset * 2;
  const columns = 7;
  const rows = [
    {
      color: '#FF6A2A',
      icons: [16, 20, 24, 32, 40, 48, 256].map(size => ({
        size,
        file: path.join(appOutputRoot, `app-icon-${size}.png`),
      })),
    },
    ...Object.entries(trayStates).map(([state, definition]) => ({
      color: definition.color,
      icons: [16, 20, 24, 32, 40, 48].map(size => ({
        size,
        file: path.join(trayOutputRoot, `tray-${state}-${size}.png`),
      })),
    })),
  ];
  const width = gap + columns * (tileSize + gap);
  const height = gap + rows.length * (tileSize + gap);
  const cells = [];
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = gap + column * (tileSize + gap);
      const y = gap + row * (tileSize + gap);
      const color = rows[row].color;
      cells.push(
        `<rect x="${x}" y="${y}" width="${tileSize}" height="${tileSize}" rx="16" fill="url(#checker)" stroke="${color}" stroke-width="3"/>`,
        `<rect x="${x + 8}" y="${y + 8}" width="${tileSize - 16}" height="5" rx="2.5" fill="${color}"/>`
      );
    }
  }
  const background = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <pattern id="checker" width="16" height="16" patternUnits="userSpaceOnUse">
          <rect width="16" height="16" fill="#14212A"/>
          <path d="M0 0H8V8H0ZM8 8H16V16H8Z" fill="#1C2B36"/>
        </pattern>
      </defs>
      <rect width="${width}" height="${height}" rx="20" fill="#081016"/>
      ${cells.join('')}
    </svg>`
  );
  const composites = [];
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < rows[row].icons.length; column += 1) {
      const icon = rows[row].icons[column];
      const resized = await sharp(await readFile(icon.file))
        .resize(displayedIconSize, displayedIconSize, {
          fit: 'contain',
          kernel: icon.size <= 48 ? sharp.kernel.nearest : sharp.kernel.lanczos3,
        })
        .png(PNG_OPTIONS)
        .toBuffer();
      composites.push({
        input: resized,
        left: gap + column * (tileSize + gap) + inset,
        top: gap + row * (tileSize + gap) + inset,
      });
    }
  }
  const buffer = await sharp(background).composite(composites).png(PNG_OPTIONS).toBuffer();
  return { buffer, width, height };
}

async function renderMaster() {
  const [background, foundryLogo, bridgeGlyph] = await Promise.all([
    readFile(backgroundAsset),
    readFile(vendorAsset),
    readFile(bridgeGlyphAsset),
  ]);

  const resizedFoundryLogo = await sharp(foundryLogo)
    .resize(710, 710, { fit: 'contain', kernel: sharp.kernel.lanczos3 })
    .png(PNG_OPTIONS)
    .toBuffer();
  const resizedBridgeGlyph = await sharp(bridgeGlyph, { density: 384 })
    .resize(400, 246, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .png(PNG_OPTIONS)
    .toBuffer();

  return sharp(background, { density: 96 })
    .resize(MASTER_SIZE, MASTER_SIZE, { fit: 'fill' })
    .composite([
      { input: resizedFoundryLogo, left: 137, top: 78 },
      { input: resizedBridgeGlyph, left: 530, top: 690 },
    ])
    .png(PNG_OPTIONS)
    .toBuffer();
}

async function renderShellFoundation() {
  const [background, foundryLogo] = await Promise.all([
    readFile(backgroundAsset),
    readFile(vendorAsset),
  ]);
  const resizedFoundryLogo = await sharp(foundryLogo)
    .resize(700, 700, { fit: 'contain', kernel: sharp.kernel.lanczos3 })
    .png(PNG_OPTIONS)
    .toBuffer();
  // The small text-free bridge mark is composited directly in physical pixels
  // after this foundation is resized, avoiding subpixel shell glyphs.
  return sharp(background, { density: 96 })
    .resize(MASTER_SIZE, MASTER_SIZE, { fit: 'fill' })
    .composite([{ input: resizedFoundryLogo, left: 132, top: 76 }])
    .png(PNG_OPTIONS)
    .toBuffer();
}

async function main() {
  const [vendorBuffer, bridgeGlyphBuffer, backgroundBuffer, generatorBuffer] = await Promise.all([
    readFile(vendorAsset),
    readFile(bridgeGlyphAsset),
    readFile(backgroundAsset),
    readFile(scriptFile),
  ]);
  const actualVendorHash = sha256(vendorBuffer);
  if (actualVendorHash !== EXPECTED_VENDOR_SHA256) {
    throw new Error(
      `Foundry Community Content Kit asset hash mismatch: expected ${EXPECTED_VENDOR_SHA256}, got ${actualVendorHash}`
    );
  }

  const vendorMetadata = await sharp(vendorBuffer).metadata();
  if (
    vendorMetadata.format !== 'png' ||
    vendorMetadata.width !== 512 ||
    vendorMetadata.height !== 512 ||
    vendorMetadata.hasAlpha !== true
  ) {
    throw new Error('The official Foundry asset must remain a transparent 512x512 PNG');
  }
  if (/<text\b/i.test(bridgeGlyphBuffer.toString('utf8'))) {
    throw new Error('The MCP bridge glyph must not contain rendered text');
  }

  assertSafeOutputPath(outputRoot);
  await rm(outputRoot, { recursive: true, force: true });
  await Promise.all([
    mkdir(appOutputRoot, { recursive: true }),
    mkdir(trayOutputRoot, { recursive: true }),
  ]);

  const manifest = {
    schemaVersion: 1,
    design: {
      id: 'foundry-d20-network-topology-v3',
      glyph: {
        file: 'brand/mcp-bridge-glyph.svg',
        sha256: sha256(bridgeGlyphBuffer),
      },
      background: {
        file: 'brand/app-icon-background.svg',
        sha256: sha256(backgroundBuffer),
      },
      generator: {
        file: '../../../scripts/build-desktop-icons.mjs',
        sha256: sha256(generatorBuffer),
      },
      foundationOnlySizes: [16, 20, 24, 32],
      topologySizes: [40, 48],
    },
    source: {
      file: 'vendor/foundry/fvtt-d20.png',
      sha256: actualVendorHash,
      width: 512,
      height: 512,
    },
    outputs: [],
    runtimeAliases: [],
  };

  const master = await renderMaster();
  await verifyTransparentPng(master, MASTER_SIZE, 'app icon master');
  const shellFoundation = await renderShellFoundation();
  await verifyTransparentPng(shellFoundation, MASTER_SIZE, 'shell icon foundation');

  const smallAppBuffers = new Map();
  for (const size of APP_PNG_SIZES) {
    const buffer =
      size <= 48
        ? await renderSmallShellIcon(shellFoundation, size, smallAppGeometry[size])
        : await resizePng(master, size);
    await verifyTransparentPng(buffer, size, `app icon ${size}`);
    await verifySmallIconLegibility(buffer, size, `app icon ${size}`, null, smallAppGeometry[size]);
    if (size <= 48) smallAppBuffers.set(size, buffer);
    const relativeFile = `app/app-icon-${size}.png`;
    await writeFile(path.join(outputRoot, relativeFile), buffer);
    manifest.outputs.push({
      file: relativeFile,
      width: size,
      height: size,
      sha256: sha256(buffer),
    });
    if (size === 512) {
      await writeFile(path.join(appOutputRoot, 'app-icon.png'), buffer);
      manifest.outputs.push({
        file: 'app/app-icon.png',
        width: size,
        height: size,
        sha256: sha256(buffer),
      });
      await writeFile(path.join(assetsRoot, 'app-icon.png'), buffer);
      manifest.runtimeAliases.push({
        file: 'app-icon.png',
        width: size,
        height: size,
        sha256: sha256(buffer),
      });
    }
  }

  const icoImages = [];
  for (const size of ICO_SIZES) {
    const buffer =
      size <= 48
        ? (smallAppBuffers.get(size) ??
          (await renderSmallShellIcon(shellFoundation, size, smallAppGeometry[size])))
        : await resizePng(master, size);
    await verifyTransparentPng(buffer, size, `ICO source frame ${size}`);
    await verifySmallIconLegibility(
      buffer,
      size,
      `ICO source frame ${size}`,
      null,
      smallAppGeometry[size]
    );
    icoImages.push({ size, buffer });
  }
  const ico = makeIco(icoImages);
  verifyIcoPayload(ico, icoImages);
  const icoSizes = readIcoSizes(ico);
  if (icoSizes.join(',') !== ICO_SIZES.join(',')) {
    throw new Error(`Generated ICO sizes are incorrect: ${icoSizes.join(', ')}`);
  }
  await writeFile(path.join(appOutputRoot, 'app-icon.ico'), ico);
  manifest.outputs.push({ file: 'app/app-icon.ico', sizes: icoSizes, sha256: sha256(ico) });
  await writeFile(path.join(assetsRoot, 'app-icon.ico'), ico);
  manifest.runtimeAliases.push({ file: 'app-icon.ico', sizes: icoSizes, sha256: sha256(ico) });

  const trayBuffersBySize = new Map();
  for (const [state, definition] of Object.entries(trayStates)) {
    for (const size of TRAY_SIZES) {
      const buffer = await renderSmallShellIcon(
        shellFoundation,
        size,
        smallTrayGeometry[size],
        definition
      );
      await verifyTransparentPng(buffer, size, `tray ${state} ${size}`);
      await verifySmallIconLegibility(
        buffer,
        size,
        `tray ${state} ${size}`,
        definition.rgb,
        smallTrayGeometry[size]
      );
      const sizeBuffers = trayBuffersBySize.get(size) ?? [];
      sizeBuffers.push({ state, buffer, geometry: smallTrayGeometry[size] });
      trayBuffersBySize.set(size, sizeBuffers);
      const relativeFile = `tray/tray-${state}-${size}.png`;
      await writeFile(path.join(outputRoot, relativeFile), buffer);
      manifest.outputs.push({
        file: relativeFile,
        width: size,
        height: size,
        sha256: sha256(buffer),
      });
      const sizeAlias = `tray-icon-${state}-${size}.png`;
      await writeFile(path.join(assetsRoot, sizeAlias), buffer);
      manifest.runtimeAliases.push({
        file: sizeAlias,
        width: size,
        height: size,
        sha256: sha256(buffer),
      });

      if (size === 16) {
        await writeFile(path.join(trayOutputRoot, `tray-${state}.png`), buffer);
        manifest.outputs.push({
          file: `tray/tray-${state}.png`,
          width: 16,
          height: 16,
          sha256: sha256(buffer),
        });
        await writeFile(path.join(assetsRoot, `tray-icon-${state}.png`), buffer);
        manifest.runtimeAliases.push({
          file: `tray-icon-${state}.png`,
          width: 16,
          height: 16,
          sha256: sha256(buffer),
        });
        if (state === 'connected') {
          await writeFile(path.join(assetsRoot, 'tray-icon.png'), buffer);
          manifest.runtimeAliases.push({
            file: 'tray-icon.png',
            width: 16,
            height: 16,
            sha256: sha256(buffer),
          });
        }
      }
      if (size === 32) {
        await writeFile(path.join(trayOutputRoot, `tray-${state}@2x.png`), buffer);
        manifest.outputs.push({
          file: `tray/tray-${state}@2x.png`,
          width: 32,
          height: 32,
          sha256: sha256(buffer),
        });
        await writeFile(path.join(assetsRoot, `tray-icon-${state}@2x.png`), buffer);
        manifest.runtimeAliases.push({
          file: `tray-icon-${state}@2x.png`,
          width: 32,
          height: 32,
          sha256: sha256(buffer),
        });
        if (state === 'connected') {
          await writeFile(path.join(assetsRoot, 'tray-icon@2x.png'), buffer);
          manifest.runtimeAliases.push({
            file: 'tray-icon@2x.png',
            width: 32,
            height: 32,
            sha256: sha256(buffer),
          });
        }
      }
    }
  }

  for (const [size, entries] of trayBuffersBySize) {
    const signatures = await Promise.all(
      entries.map(entry => stateMarkSignature(entry.buffer, size, entry.geometry))
    );
    if (new Set(signatures).size !== entries.length) {
      throw new Error(`Tray connection-state marks are not distinguishable at ${size}px`);
    }
  }

  const preview = await renderPreviewSheet();
  await writeFile(path.join(outputRoot, 'icon-preview.png'), preview.buffer);
  manifest.outputs.push({
    file: 'icon-preview.png',
    width: preview.width,
    height: preview.height,
    sha256: sha256(preview.buffer),
  });

  manifest.outputs.sort((left, right) => left.file.localeCompare(right.file));
  manifest.runtimeAliases.sort((left, right) => left.file.localeCompare(right.file));
  await writeFile(
    path.join(outputRoot, 'icon-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  console.log(`Verified official Foundry asset: ${actualVendorHash}`);
  console.log(`Generated ${manifest.outputs.length} deterministic icon outputs in ${outputRoot}`);
  console.log(`Windows ICO frames: ${icoSizes.join(', ')}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
