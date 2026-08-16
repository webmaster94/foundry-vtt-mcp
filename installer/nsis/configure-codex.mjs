#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OWNER_ID = 'io.github.webmaster94.foundry-vtt-mcp';
const PRIMARY_NAME = 'foundry-mcp';
const KNOWN_NAMES = new Set(['foundry-mcp', 'foundry-vtt-mcp', 'foundry-vtt-mcp-bridge']);

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const options = { installDir: null, remove: false, configPaths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--install-dir') {
      options.installDir = argv[++index];
    } else if (argument === '--remove') {
      options.remove = true;
    } else if (argument === '--config') {
      options.configPaths.push(argv[++index]);
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  if (!options.installDir || !path.win32.isAbsolute(options.installDir)) {
    fail('--install-dir must be an absolute Windows path');
  }
  options.installDir = path.win32.normalize(options.installDir);
  if (options.configPaths.some(value => !value || !path.win32.isAbsolute(value))) {
    fail('--config values must be absolute Windows paths');
  }
  options.configPaths = options.configPaths.map(value => path.win32.normalize(value));
  return options;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function decodeUtf8(buffer, configPath) {
  let bom = false;
  let body = buffer;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    bom = true;
    body = buffer.subarray(3);
  }
  if (
    body.length >= 2 &&
    ((body[0] === 0xff && body[1] === 0xfe) || (body[0] === 0xfe && body[1] === 0xff))
  ) {
    fail(`Codex configuration is UTF-16 and was left unchanged: ${configPath}`);
  }
  const text = body.toString('utf8');
  if (text.includes('\uFFFD') || !Buffer.from(text, 'utf8').equals(body)) {
    fail(`Codex configuration is not valid UTF-8 and was left unchanged: ${configPath}`);
  }
  return { text, bom };
}

function parseBasicString(source) {
  try {
    return JSON.parse(source);
  } catch {
    fail(`Unsupported TOML basic string: ${source}`);
  }
}

function parseDottedKey(source) {
  const segments = [];
  let index = 0;
  const skipWhitespace = () => {
    while (index < source.length && (source[index] === ' ' || source[index] === '\t')) index += 1;
  };
  while (index < source.length) {
    skipWhitespace();
    if (index >= source.length) break;
    let segment = '';
    if (source[index] === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      for (; index < source.length; index += 1) {
        const character = source[index];
        if (!escaped && character === '"') {
          index += 1;
          segment = parseBasicString(source.slice(start, index));
          break;
        }
        if (!escaped && character === '\\') escaped = true;
        else escaped = false;
      }
      if (segment === '') fail(`Unsupported or empty quoted TOML key: ${source}`);
    } else if (source[index] === "'") {
      const end = source.indexOf("'", index + 1);
      if (end === -1) fail(`Unterminated literal TOML key: ${source}`);
      segment = source.slice(index + 1, end);
      index = end + 1;
      if (segment === '') fail(`Empty literal TOML key: ${source}`);
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(source.slice(index));
      if (!match) fail(`Unsupported TOML key syntax: ${source}`);
      segment = match[0];
      index += match[0].length;
    }
    segments.push(segment);
    skipWhitespace();
    if (index >= source.length) break;
    if (source[index] !== '.') fail(`Unsupported TOML dotted key syntax: ${source}`);
    index += 1;
  }
  if (segments.length === 0) fail(`Empty TOML key: ${source}`);
  return segments;
}

function parseHeaderLine(line) {
  let index = 0;
  while (line[index] === ' ' || line[index] === '\t') index += 1;
  if (line[index] !== '[') return null;
  if (line[index + 1] === '[') {
    if (line.includes('mcp_servers') && [...KNOWN_NAMES].some(name => line.includes(name))) {
      fail(`Array-table syntax is not supported for a known Codex MCP entry: ${line}`);
    }
    return null;
  }
  const bodyStart = ++index;
  let quote = null;
  let escaped = false;
  for (; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"') {
      if (!escaped && character === '"') quote = null;
      if (!escaped && character === '\\') escaped = true;
      else escaped = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character !== ']') continue;
    const remainder = line.slice(index + 1).trimStart();
    if (remainder !== '' && !remainder.startsWith('#')) {
      fail(`Unsupported content after TOML table header: ${line}`);
    }
    return parseDottedKey(line.slice(bodyStart, index));
  }
  fail(`Unterminated TOML table header: ${line}`);
}

function updateMultilineState(line, initialState) {
  let state = initialState;
  for (let index = 0; index < line.length; index += 1) {
    if (state === 'multiline-basic') {
      if (line.startsWith('"""', index)) {
        let backslashes = 0;
        for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) {
          backslashes += 1;
        }
        if (backslashes % 2 === 0) {
          state = null;
          index += 2;
        }
      }
      continue;
    }
    if (state === 'multiline-literal') {
      if (line.startsWith("'''", index)) {
        state = null;
        index += 2;
      }
      continue;
    }
    const character = line[index];
    if (character === '#') break;
    if (line.startsWith('"""', index)) {
      state = 'multiline-basic';
      index += 2;
      continue;
    }
    if (line.startsWith("'''", index)) {
      state = 'multiline-literal';
      index += 2;
      continue;
    }
    if (character === '"') {
      index += 1;
      let escaped = false;
      for (; index < line.length; index += 1) {
        if (!escaped && line[index] === '"') break;
        if (!escaped && line[index] === '\\') escaped = true;
        else escaped = false;
      }
      continue;
    }
    if (character === "'") {
      const end = line.indexOf("'", index + 1);
      if (end === -1) fail(`Unterminated TOML literal string: ${line}`);
      index = end;
    }
  }
  return state;
}

function splitLines(text) {
  const lines = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline + 1;
    let line = text.slice(start, newline === -1 ? end : newline);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    lines.push({ start, end, line });
    start = end;
  }
  return lines;
}

function assignmentKey(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"') {
      if (!escaped && character === '"') quote = null;
      if (!escaped && character === '\\') escaped = true;
      else escaped = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '#') return null;
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '=') return parseDottedKey(line.slice(0, index).trim());
  }
  return null;
}

function assertSupportedKnownAssignments(text, headers) {
  const headerByStart = new Map(headers.map(header => [header.start, header]));
  let currentTable = [];
  let multilineState = null;
  for (const line of splitLines(text)) {
    const header = headerByStart.get(line.start);
    if (header) {
      currentTable = header.segments;
      multilineState = updateMultilineState(line.line, multilineState);
      continue;
    }
    if (multilineState !== null) {
      multilineState = updateMultilineState(line.line, multilineState);
      continue;
    }
    const currentKnown = currentTable[0] === 'mcp_servers' && KNOWN_NAMES.has(currentTable[1]);
    const couldDefineKnown =
      line.line.includes('mcp_servers') ||
      (currentTable.length === 1 &&
        currentTable[0] === 'mcp_servers' &&
        [...KNOWN_NAMES].some(name => line.line.includes(name)));
    if (!currentKnown && !couldDefineKnown) {
      multilineState = updateMultilineState(line.line, multilineState);
      continue;
    }
    const key = assignmentKey(line.line);
    if (key) {
      const semantic = [...currentTable, ...key];
      if (currentKnown && key.length !== 1) {
        fail(`Dotted assignments inside a known Codex MCP table are not supported: ${line.line}`);
      }
      if (semantic[0] === 'mcp_servers' && KNOWN_NAMES.has(semantic[1]) && !currentKnown) {
        fail(`Inline or dotted known Codex MCP definitions are not supported: ${line.line}`);
      }
      if (
        semantic.length === 1 &&
        semantic[0] === 'mcp_servers' &&
        [...KNOWN_NAMES].some(name => line.line.includes(name))
      ) {
        fail(`Inline known Codex MCP definitions are not supported: ${line.line}`);
      }
    }
    multilineState = updateMultilineState(line.line, multilineState);
  }
}

function parseDocument(text) {
  const headers = [];
  let multilineState = null;
  for (const line of splitLines(text)) {
    if (multilineState === null) {
      const segments = parseHeaderLine(line.line);
      if (segments) headers.push({ start: line.start, headerEnd: line.end, segments });
    }
    multilineState = updateMultilineState(line.line, multilineState);
  }
  if (multilineState !== null) fail('Unterminated multiline string in Codex configuration');

  assertSupportedKnownAssignments(text, headers);

  const sections = headers.map((header, index) => ({
    ...header,
    end: index + 1 < headers.length ? headers[index + 1].start : text.length,
    raw: text.slice(
      header.start,
      index + 1 < headers.length ? headers[index + 1].start : text.length
    ),
  }));
  const groups = new Map();
  for (const section of sections) {
    if (section.segments[0] !== 'mcp_servers' || !KNOWN_NAMES.has(section.segments[1])) continue;
    const name = section.segments[1];
    if (!groups.has(name)) groups.set(name, { name, root: [], env: [], descendants: [] });
    const group = groups.get(name);
    group.descendants.push(section);
    if (section.segments.length === 2) group.root.push(section);
    if (section.segments.length === 3 && section.segments[2] === 'env') group.env.push(section);
  }
  for (const group of groups.values()) {
    if (group.root.length !== 1 || group.env.length > 1) {
      fail(`Ambiguous or incomplete Codex MCP table for '${group.name}'`);
    }
  }
  return { sections, groups };
}

const TOML_STRING = String.raw`(?:"(?:\\.|[^"\\])*"|'[^']*')`;

function parseTomlString(source) {
  if (source.startsWith("'")) return source.slice(1, -1);
  return parseBasicString(source);
}

function assignmentLines(section, key) {
  const matches = [];
  let multilineState = null;
  let firstLine = true;
  for (const line of splitLines(section.raw)) {
    if (firstLine) {
      firstLine = false;
      multilineState = updateMultilineState(line.line, multilineState);
      continue;
    }
    if (multilineState === null) {
      const parsedKey = assignmentKey(line.line);
      if (parsedKey?.length === 1 && parsedKey[0] === key) matches.push(line.line);
    }
    multilineState = updateMultilineState(line.line, multilineState);
  }
  return matches;
}

function readScalar(section, key) {
  const expression = new RegExp(
    `^[ \\t]*${key}[ \\t]*=[ \\t]*(?<value>${TOML_STRING})[ \\t]*(?:#.*)?$`
  );
  const values = assignmentLines(section, key)
    .map(line => expression.exec(line))
    .filter(Boolean)
    .map(match => parseTomlString(match.groups.value));
  if (values.length > 1) fail(`Duplicate '${key}' value in ${section.segments.join('.')}`);
  return values[0] ?? null;
}

function readOnlyArgument(section) {
  const expression = new RegExp(
    `^[ \\t]*args[ \\t]*=[ \\t]*\\[[ \\t]*(?<value>${TOML_STRING})[ \\t]*,?[ \\t]*\\][ \\t]*(?:#.*)?$`
  );
  const values = assignmentLines(section, 'args')
    .map(line => expression.exec(line))
    .filter(Boolean)
    .map(match => parseTomlString(match.groups.value));
  if (values.length > 1) fail(`Duplicate 'args' value in ${section.segments.join('.')}`);
  return values[0] ?? null;
}

function expandWindowsEnvironment(value) {
  return value.replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match);
}

function normalizeAbsoluteWindowsPath(value) {
  if (!value) return null;
  const expanded = expandWindowsEnvironment(value);
  if (!path.win32.isAbsolute(expanded)) return null;
  return path.win32
    .normalize(expanded)
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}

function sameWindowsPath(left, right) {
  const normalizedLeft = normalizeAbsoluteWindowsPath(left);
  const normalizedRight = normalizeAbsoluteWindowsPath(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

function isOwned(group) {
  const root = group.root[0];
  const env = group.env[0] ?? null;
  if (env && readScalar(env, 'FOUNDRY_MCP_MANAGED_BY') === OWNER_ID) return true;

  const command = readScalar(root, 'command');
  const argument = readOnlyArgument(root);
  const normalizedCommand = normalizeAbsoluteWindowsPath(command);
  if (!normalizedCommand || !argument) return false;
  const commandName = path.win32.basename(normalizedCommand);
  const commandParent = path.win32.dirname(normalizedCommand);
  if (commandName === 'foundryvtt mcp bridge.exe') {
    return sameWindowsPath(
      argument,
      path.win32.join(commandParent, 'resources', 'server', 'index.bundle.cjs')
    );
  }
  if (commandName !== 'node.exe') return false;
  const legacyArgument = path.win32.join(
    commandParent,
    'foundry-mcp-server',
    'packages',
    'mcp-server',
    'dist',
    'index.cjs'
  );
  if (sameWindowsPath(argument, legacyArgument)) return true;
  if (path.win32.basename(commandParent) !== 'runtime') return false;
  const currentRoot = path.win32.dirname(commandParent);
  return sameWindowsPath(
    argument,
    path.win32.join(currentRoot, 'resources', 'server', 'index.bundle.cjs')
  );
}

function renderEntry(name, installDir, newline) {
  const command = path.win32.join(installDir, 'FoundryVTT MCP Bridge.exe');
  const argument = path.win32.join(installDir, 'resources', 'server', 'index.bundle.cjs');
  const config = path.win32.join(
    process.env.APPDATA ?? path.win32.join(os.homedir(), 'AppData', 'Roaming'),
    'FoundryVTT MCP Bridge',
    'foundry-servers.json'
  );
  return (
    `[mcp_servers.${JSON.stringify(name)}]${newline}` +
    `command = ${JSON.stringify(command)}${newline}` +
    `args = [${JSON.stringify(argument)}]${newline}${newline}` +
    `[mcp_servers.${JSON.stringify(name)}.env]${newline}` +
    `ELECTRON_RUN_AS_NODE = "1"${newline}` +
    `FOUNDRY_SERVERS_CONFIG = ${JSON.stringify(config)}${newline}` +
    `FOUNDRY_MCP_MANAGED_BY = ${JSON.stringify(OWNER_ID)}${newline}`
  );
}

function applyOperations(text, sections, operations, appendText) {
  let output = '';
  let cursor = 0;
  for (const section of sections) {
    output += text.slice(cursor, section.start);
    output += operations.has(section.start) ? operations.get(section.start) : section.raw;
    cursor = section.end;
  }
  output += text.slice(cursor);
  if (appendText) {
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    if (output.length > 0 && !output.endsWith('\n')) output += newline;
    if (output.length > 0 && !output.endsWith(`${newline}${newline}`)) output += newline;
    output += appendText;
  }
  return output;
}

function planInstall(text, installDir) {
  const parsed = parseDocument(text);
  const operations = new Map();
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const primary = parsed.groups.get(PRIMARY_NAME);
  if (primary && !isOwned(primary)) {
    fail(`The '${PRIMARY_NAME}' Codex entry is not owned by this bridge and was left unchanged`);
  }

  let appendText = '';
  if (primary) {
    operations.set(primary.root[0].start, renderEntry(PRIMARY_NAME, installDir, newline));
    for (const section of primary.descendants) {
      if (section !== primary.root[0]) operations.set(section.start, '');
    }
  } else {
    appendText = renderEntry(PRIMARY_NAME, installDir, newline);
  }

  for (const name of KNOWN_NAMES) {
    if (name === PRIMARY_NAME) continue;
    const group = parsed.groups.get(name);
    if (!group || !isOwned(group)) continue;
    for (const section of group.descendants) operations.set(section.start, '');
  }

  const candidate = applyOperations(text, parsed.sections, operations, appendText);
  const validation = parseDocument(candidate).groups.get(PRIMARY_NAME);
  if (!validation || !isOwned(validation))
    fail('Generated Codex configuration failed ownership validation');
  return candidate;
}

function planRemoval(text) {
  const parsed = parseDocument(text);
  const operations = new Map();
  for (const name of KNOWN_NAMES) {
    const group = parsed.groups.get(name);
    if (!group || !isOwned(group)) continue;
    for (const section of group.descendants) operations.set(section.start, '');
  }
  if (operations.size === 0) return text;
  return applyOperations(text, parsed.sections, operations, '');
}

function writeAtomic(configPath, originalBytes, candidateText, bom) {
  const parent = path.dirname(configPath);
  const suffix = `${new Date().toISOString().replace(/[:.]/g, '')}-${crypto.randomUUID()}`;
  const temporaryPath = `${configPath}.tmp-${suffix}`;
  const backupPath = `${configPath}.backup-${suffix}`;
  const body = Buffer.from(candidateText, 'utf8');
  const candidateBytes = bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
  fs.writeFileSync(temporaryPath, candidateBytes, { flag: 'wx' });
  try {
    const currentBytes = fs.readFileSync(configPath);
    if (sha256(currentBytes) !== sha256(originalBytes)) {
      fail(`Codex configuration changed during migration and was left unchanged: ${configPath}`);
    }
    fs.writeFileSync(backupPath, currentBytes, { flag: 'wx' });
    fs.renameSync(temporaryPath, configPath);
    process.stdout.write(`Backed up Codex configuration to ${backupPath}\n`);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function configureOne(configPath, options) {
  if (!fs.existsSync(configPath)) return false;
  const stat = fs.lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(
      `Codex configuration is linked or not a regular file and was left unchanged: ${configPath}`
    );
  }
  const originalBytes = fs.readFileSync(configPath);
  const { text, bom } = decodeUtf8(originalBytes, configPath);
  const candidate = options.remove ? planRemoval(text) : planInstall(text, options.installDir);
  if (candidate === text) {
    process.stdout.write(`No installer-owned Codex entry required a change in ${configPath}\n`);
    return false;
  }
  writeAtomic(configPath, originalBytes, candidate, bom);
  process.stdout.write(
    `${options.remove ? 'Removed installer-owned entries from' : 'Configured'} ${configPath}\n`
  );
  return true;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.remove) {
    for (const required of [
      path.win32.join(options.installDir, 'FoundryVTT MCP Bridge.exe'),
      path.win32.join(options.installDir, 'resources', 'server', 'index.bundle.cjs'),
    ]) {
      if (!fs.existsSync(required) || !fs.lstatSync(required).isFile()) {
        fail(`Required installed bridge file is missing: ${required}`);
      }
    }
  }
  const configPaths =
    options.configPaths.length > 0
      ? options.configPaths
      : [path.win32.join(process.env.USERPROFILE ?? os.homedir(), '.codex', 'config.toml')];
  for (const configPath of configPaths) configureOne(configPath, options);
}

try {
  main();
} catch (error) {
  process.stderr.write(`Codex MCP configuration was left unchanged: ${error.message}\n`);
  process.exitCode = 1;
}
