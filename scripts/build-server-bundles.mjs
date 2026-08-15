import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');
const serverRoot = path.join(repoRoot, 'packages', 'mcp-server');
const serverPackage = JSON.parse(fs.readFileSync(path.join(serverRoot, 'package.json'), 'utf8'));

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  define: {
    'import.meta.url': JSON.stringify('bundled'),
    __FOUNDRY_MCP_VERSION__: JSON.stringify(serverPackage.version),
  },
};

await Promise.all([
  build({
    ...common,
    entryPoints: [path.join(serverRoot, 'dist', 'index.js')],
    outfile: path.join(serverRoot, 'dist', 'index.bundle.cjs'),
  }),
  build({
    ...common,
    entryPoints: [path.join(serverRoot, 'dist', 'backend.js')],
    outfile: path.join(serverRoot, 'dist', 'backend.bundle.cjs'),
  }),
]);

console.log(`[bundle] MCP server ${serverPackage.version}`);
