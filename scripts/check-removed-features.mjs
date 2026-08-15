import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');

const removedPaths = [
  'packages/foundry-module/src/comfyui-manager.ts',
  'packages/foundry-module/styles/enhanced-creature-index.css',
  'packages/foundry-module/templates/comfyui-settings.html',
  'packages/foundry-module/templates/enhanced-index-menu.html',
  'packages/mcp-server/src/comfyui-client.ts',
  'packages/mcp-server/src/job-queue.ts',
  'packages/mcp-server/src/tools/map-generation.ts',
  'packages/mcp-server/src/utils/comfyui-paths.ts',
  'packages/mcp-server/src/systems/index-builder-registry.ts',
];

const removedRuntimeIdentifiers = [
  'generate-map',
  'check-map-status',
  'cancel-map-job',
  'upload-generated-map',
  'generate-map-request',
  'check-map-status-request',
  'cancel-map-job-request',
  'start-comfyui-service',
  'stop-comfyui-service',
  'check-comfyui-status',
  'list-creatures-by-criteria',
  'build-enhanced-index',
  'enhancedCreatureIndex',
  'openEnhancedIndex',
  'openComfyUISettings',
  'listCreaturesByCriteria',
  'getEnhancedCreatureIndex',
];

const runtimeRoots = [
  'packages/foundry-module/src',
  'packages/foundry-module/templates',
  'packages/foundry-module/styles',
  'packages/mcp-server/src',
  'shared/src',
];

const buildRoots = ['packages/foundry-module/dist', 'packages/mcp-server/dist', 'shared/dist'];
const textExtensions = new Set(['.cjs', '.css', '.hbs', '.html', '.js', '.json', '.mjs', '.ts']);
const failures = [];

for (const relativePath of removedPaths) {
  if (fs.existsSync(path.join(repoRoot, relativePath))) {
    failures.push(`removed path still exists: ${relativePath}`);
  }
}

function collectTextFiles(relativeRoot) {
  const absoluteRoot = path.join(repoRoot, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) return [];

  const files = [];
  const pending = [absoluteRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && textExtensions.has(path.extname(entry.name))) files.push(entryPath);
    }
  }
  return files;
}

for (const relativeRoot of [...runtimeRoots, ...buildRoots]) {
  for (const absolutePath of collectTextFiles(relativeRoot)) {
    const contents = fs.readFileSync(absolutePath, 'utf8');
    for (const identifier of removedRuntimeIdentifiers) {
      if (contents.includes(identifier)) {
        failures.push(
          `removed runtime identifier "${identifier}" remains in ${path.relative(repoRoot, absolutePath)}`
        );
      }
    }
  }
}

const moduleManifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'packages/foundry-module/module.json'), 'utf8')
);
const manifestAssets = [
  ...(Array.isArray(moduleManifest.styles) ? moduleManifest.styles : []),
  ...(Array.isArray(moduleManifest.esmodules) ? moduleManifest.esmodules : []),
];
for (const asset of manifestAssets) {
  if (/comfy|enhanced-creature-index/i.test(asset)) {
    failures.push(`module manifest still loads a removed asset: ${asset}`);
  }
}

if (failures.length > 0) {
  console.error('[Removed Feature Check] FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  '[Removed Feature Check] PASS: AI map generation, ComfyUI integration, and the Enhanced Creature Index are absent from runtime source and build output.'
);
