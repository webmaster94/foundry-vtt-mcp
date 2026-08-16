import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(packageRoot, 'src');
const outputRoot = path.join(packageRoot, 'dist');

await fs.mkdir(outputRoot, { recursive: true });

await Promise.all([
  build({
    entryPoints: [path.join(sourceRoot, 'main', 'main.ts')],
    outfile: path.join(outputRoot, 'main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: true,
  }),
  build({
    entryPoints: [path.join(sourceRoot, 'preload.ts')],
    outfile: path.join(outputRoot, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: true,
  }),
  build({
    entryPoints: [path.join(sourceRoot, 'renderer', 'app.ts')],
    outfile: path.join(outputRoot, 'renderer.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome150',
    sourcemap: true,
  }),
]);

await Promise.all([
  fs.copyFile(path.join(sourceRoot, 'renderer', 'index.html'), path.join(outputRoot, 'index.html')),
  fs.copyFile(path.join(sourceRoot, 'renderer', 'styles.css'), path.join(outputRoot, 'styles.css')),
  fs.cp(path.join(packageRoot, 'assets'), path.join(outputRoot, 'assets'), {
    recursive: true,
  }),
]);

console.log(`[desktop] Built ${outputRoot}`);
