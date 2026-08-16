import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// Every manifest that carries a version. These must always agree: the module.json
// version is what Foundry advertises for updates, and the package.json versions are
// what the server artifacts report. When they drift (as in #69, where module.json
// was bumped to 0.8.3 in a feature PR while the packages stayed 0.8.2), releases
// ship inconsistent version numbers and the Foundry update check misbehaves.
// Release workflows pass --expected vX.Y.Z so a tag/manual artifact label can
// never drift from the version embedded in the server and module payloads.
const FILES = [
  'package.json',
  'packages/mcp-server/package.json',
  'packages/foundry-module/package.json',
  'packages/desktop/package.json',
  'shared/package.json',
  'packages/foundry-module/module.json',
];

const entries = FILES.map(file => {
  const full = path.join(repoRoot, file);
  const version = JSON.parse(fs.readFileSync(full, 'utf8')).version;
  return { file, version };
});

for (const { file, version } of entries) {
  console.log(`  ${String(version).padEnd(10)} ${file}`);
}

const invalidEntries = entries.filter(
  ({ version }) => typeof version !== 'string' || version.length === 0
);
if (invalidEntries.length > 0) {
  console.error(
    `\n[version-check] FAIL — missing or invalid version in: ${invalidEntries.map(({ file }) => file).join(', ')}`
  );
  process.exit(1);
}

const distinct = [...new Set(entries.map(e => e.version))];
const expectedIndex = process.argv.indexOf('--expected');
let expectedVersion;

if (expectedIndex >= 0) {
  const supplied = process.argv[expectedIndex + 1];
  if (!supplied || supplied.startsWith('--')) {
    console.error('\n[version-check] FAIL — --expected requires a release version.');
    process.exit(1);
  }
  expectedVersion = supplied.startsWith('v') ? supplied.slice(1) : supplied;
}

if (distinct.length !== 1) {
  console.error(
    `\n[version-check] FAIL — found ${distinct.length} distinct versions: ${distinct.join(', ')}`
  );
  console.error(
    '  All package.json files and module.json must share one version. Bump them together'
  );
  console.error('  in a single "chore(release): prepare vX.Y.Z" commit before tagging a release.');
  process.exit(1);
}

const manifestVersion = distinct[0];
console.log(`\n[version-check] OK — all ${entries.length} manifests agree: ${manifestVersion}`);

if (expectedVersion !== undefined) {
  if (expectedVersion !== manifestVersion) {
    console.error(
      `[version-check] FAIL — selected release version ${expectedVersion} does not match manifests ${manifestVersion}.`
    );
    console.error('  Bump all manifests first; release workflows never restamp around a mismatch.');
    process.exit(1);
  }
  console.log(`[version-check] OK — selected release version matches: ${manifestVersion}`);
}
