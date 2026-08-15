import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');

const TARGETS = {
  module: ['packages/foundry-module/dist'],
  server: ['packages/mcp-server/dist', 'packages/mcp-server/tsconfig.tsbuildinfo'],
  shared: ['shared/dist', 'shared/tsconfig.tsbuildinfo'],
};

const requested = process.argv.slice(2);
const targetNames = requested.length ? requested : Object.keys(TARGETS);

for (const name of targetNames) {
  if (!Object.prototype.hasOwnProperty.call(TARGETS, name)) {
    throw new Error(`Unknown clean target "${name}". Expected: ${Object.keys(TARGETS).join(', ')}`);
  }
}

for (const name of targetNames) {
  for (const relativePath of TARGETS[name]) {
    const target = path.resolve(repoRoot, relativePath);
    const relativeToRoot = path.relative(repoRoot, target);
    if (!relativeToRoot || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      throw new Error(`Refusing to clean path outside the repository: ${target}`);
    }
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`[clean] ${relativePath}`);
  }
}
