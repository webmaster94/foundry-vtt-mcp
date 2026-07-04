#!/usr/bin/env node
/**
 * Integration smoke test for the Foundry MCP bridge.
 *
 * Drives the backend's control channel (TCP 31414, JSON-lines) exactly like
 * the stdio wrapper does, against a LIVE connected Foundry world. Exercises
 * the full write surface end to end: documents, embedded documents, batch,
 * dry-run, undo, macros, script execution, actor building, and audit.
 *
 * Usage:
 *   npm run smoke              # requires backend running + world connected
 *   node scripts/bridge-smoke-test.mjs [--server <profile>]
 *
 * Exit code 0 = all pass. Non-zero = failures (each listed in the report).
 */
import * as net from 'net';

const CONTROL_HOST = '127.0.0.1';
const CONTROL_PORT = 31414;
const serverArgIdx = process.argv.indexOf('--server');
const SERVER = serverArgIdx > -1 ? process.argv[serverArgIdx + 1] : undefined;

class Control {
  constructor() {
    this.pending = new Map();
    this.buffer = '';
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ host: CONTROL_HOST, port: CONTROL_PORT }, resolve);
      this.socket.setEncoding('utf8');
      this.socket.on('data', chunk => this.onData(chunk));
      this.socket.on('error', reject);
    });
  }
  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }
  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify({ id, method, params }) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout waiting for ${method}`));
        }
      }, 30000);
    });
  }
  async callTool(name, args = {}) {
    const finalArgs = SERVER ? { ...args, server: SERVER } : args;
    const res = await this.send('call_tool', { name, args: finalArgs });
    const text = res?.content?.[0]?.text ?? '';
    if (res?.isError) throw new Error(text);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  close() {
    this.socket?.destroy();
  }
}

const results = [];
async function step(name, fn) {
  const start = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - start, detail });
    console.log(`  PASS  ${name} (${Date.now() - start}ms)`);
    return detail;
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - start, error: error.message });
    console.log(`  FAIL  ${name}: ${error.message}`);
    return null;
  }
}

const control = new Control();
try {
  await control.connect();
} catch (error) {
  console.error(`Cannot reach backend control channel on ${CONTROL_HOST}:${CONTROL_PORT}.`);
  console.error('Start the MCP server (or make any tool call from Claude) first.');
  process.exit(2);
}

console.log('Foundry MCP bridge smoke test');
console.log('=============================');

// --- connectivity & capabilities
const tools = await step('list_tools returns a healthy tool count', async () => {
  const res = await control.send('list_tools', {});
  if (!res?.tools || res.tools.length < 50) throw new Error(`Only ${res?.tools?.length ?? 0} tools`);
  return { toolCount: res.tools.length };
});

await step('tool catalog stays inside the context budget (<70KB)', async () => {
  const res = await control.send('list_tools', {});
  const chars = JSON.stringify(res.tools).length;
  if (chars > 70_000) throw new Error(`Catalog is ${chars} chars — budget regression (was 86KB pre-trim)`);
  return { chars, estTokens: Math.round(chars / 4), tools: res.tools.length };
});

const world = await step('get-world-info (world connected)', async () => {
  const info = await control.callTool('get-world-info');
  if (!info?.id) throw new Error('No world id in response');
  return { world: info.id, system: info.system?.id };
});

if (!world) {
  console.log('\nNo world connected — aborting the write-path tests.');
  report();
}

await step('list-foundry-servers shows profiles', async () => {
  const res = await control.callTool('list-foundry-servers');
  if (!res?.servers?.length) throw new Error('No servers listed');
  return { servers: res.servers.map(s => `${s.name}:${s.connected ? 'up' : 'down'}`).join(', ') };
});

// --- document CRUD + dry-run + undo
let folderId = null;
await step('create-folder', async () => {
  const res = await control.callTool('create-folder', {
    data: { name: 'Smoke Test Folder', type: 'Actor' },
  });
  folderId = res?.document?.id;
  if (!folderId) throw new Error('No folder id returned');
  return { id: folderId };
});

await step('update-document dryRun returns diff without applying', async () => {
  const res = await control.callTool('update-document', {
    ref: { documentType: 'Folder', id: folderId },
    updates: { name: 'Smoke Renamed' },
    dryRun: true,
  });
  const dry = res?.document ?? res;
  if (!dry?.dryRun || !dry?.diff?.name) throw new Error('No diff in dry-run response');
  const check = await control.callTool('get-document', { ref: { documentType: 'Folder', id: folderId } });
  if ((check?.document ?? check)?.name !== 'Smoke Test Folder') throw new Error('Dry run APPLIED the change!');
  return dry.diff;
});

await step('update-document applies for real', async () => {
  const res = await control.callTool('update-document', {
    ref: { documentType: 'Folder', id: folderId },
    updates: { name: 'Smoke Renamed' },
  });
  const doc = res?.document ?? res;
  if (doc?.name !== 'Smoke Renamed') throw new Error('Rename not applied');
  return { name: doc.name };
});

await step('undo-last-mcp-operation reverts the rename', async () => {
  const res = await control.callTool('undo-last-mcp-operation', { confirmUndo: true });
  if (!res?.success) throw new Error('Undo did not report success');
  const check = await control.callTool('get-document', { ref: { documentType: 'Folder', id: folderId } });
  const name = (check?.document ?? check)?.name;
  if (name !== 'Smoke Test Folder') throw new Error(`Name is "${name}" after undo`);
  return res.undoneEntry;
});

// --- actor building + embedded batch
let actorUuid = null;
await step('build-actor-from-spec creates a complete NPC', async () => {
  const res = await control.callTool('build-actor-from-spec', {
    spec: {
      name: 'Smoke Test NPC',
      type: 'npc',
      folder: 'Smoke Test Folder',
      system: { attributes: { hp: { value: 33, max: 33 } } },
      features: [{ name: 'Smoke Feature', description: '<p>Test feature.</p>' }],
    },
  });
  actorUuid = res?.actor?.uuid;
  if (!actorUuid) throw new Error('No actor uuid returned');
  return { uuid: actorUuid, items: res.itemCount, unresolved: res.unresolved?.length ?? 0 };
});

await step('create-embedded-documents adds several items at once', async () => {
  const res = await control.callTool('create-embedded-documents', {
    parentUuid: actorUuid,
    embeddedType: 'Item',
    data: [
      { name: 'Smoke Item A', type: 'feat' },
      { name: 'Smoke Item B', type: 'feat' },
      { name: 'Smoke Item C', type: 'feat' },
    ],
  });
  if (res?.count !== 3) throw new Error(`Expected 3 created, got ${res?.count}`);
  return { count: res.count };
});

await step('batch-document-operations runs ordered ops', async () => {
  const res = await control.callTool('batch-document-operations', {
    operations: [
      { action: 'update', ref: { uuid: actorUuid }, updates: { 'system.attributes.hp.value': 20 } },
      { action: 'update', ref: { uuid: actorUuid }, updates: { 'system.attributes.hp.value': 33 } },
    ],
  });
  if (res?.succeeded !== 2) throw new Error(`Expected 2 successes, got ${res?.succeeded}`);
  return { succeeded: res.succeeded };
});

// --- schema, search, macro, script, audit
await step('get-document-schema returns clean field paths', async () => {
  const res = await control.callTool('get-document-schema', { documentType: 'Actor' });
  const paths = res?.schema?.fields?.map(f => f.path) ?? [];
  if (!paths.includes('name')) throw new Error('Schema fields missing "name"');
  if (JSON.stringify(res).includes('[Circular]')) throw new Error('Schema still contains [Circular] noise');
  return { fieldCount: paths.length, types: res.schema.types };
});

await step('search-compendium-contents filters on system data', async () => {
  const res = await control.callTool('search-compendium-contents', {
    documentType: 'Item',
    filters: [{ path: 'type', value: 'spell' }],
    limit: 5,
  });
  if (!res?.results) throw new Error('No results array');
  return { count: res.count, scanned: res.entriesScanned };
});

await step('macro create/execute/delete round-trip', async () => {
  const created = await control.callTool('create-macro', {
    name: 'Smoke Macro',
    type: 'script',
    command: 'return 40 + 2;',
  });
  const id = created?.document?.id;
  if (!id) throw new Error('No macro id');
  const executed = await control.callTool('execute-macro', { id });
  if (executed?.result?.value !== 42) throw new Error(`Macro returned ${JSON.stringify(executed?.result)}`);
  await control.callTool('delete-macro', { ref: { id }, confirmDeletion: true });
  return { value: 42 };
});

await step('execute-foundry-script runs in GM browser', async () => {
  const res = await control.callTool('execute-foundry-script', {
    code: 'return { world: game.world.id, ok: true };',
  });
  if (!res?.result?.ok) throw new Error('Script did not return ok');
  return res.result;
});

// --- v0.11: combat, effects, events, undo groups, assets, logs, scene builder
await step('apply-damage / apply-healing round-trip with undo', async () => {
  const before = await control.callTool('get-document', { ref: { uuid: actorUuid }, fields: ['system.attributes.hp'] });
  const damaged = await control.callTool('apply-damage', { target: { uuid: actorUuid }, amount: 7 });
  if (damaged?.hp?.value !== 26) throw new Error(`Expected HP 26 after 7 damage from 33, got ${damaged?.hp?.value}`);
  const healed = await control.callTool('apply-healing', { target: { uuid: actorUuid }, amount: 3 });
  if (healed?.hp?.value !== 29) throw new Error(`Expected HP 29 after heal, got ${healed?.hp?.value}`);
  const undo = await control.callTool('undo-last-mcp-operation', { confirmUndo: true });
  if (!undo?.success) throw new Error('Undo of healing failed');
  return { damaged: damaged.hp, healed: healed.hp, undone: true };
});

await step('add-active-effect creates an undoable effect', async () => {
  const res = await control.callTool('add-active-effect', {
    target: { uuid: actorUuid },
    name: 'Smoke Blessing',
    changes: [{ key: 'system.attributes.ac.bonus', mode: 2, value: 2 }],
    duration: { rounds: 10 },
  });
  if (!res?.effect?.id) throw new Error('No effect id returned');
  await control.callTool('undo-last-mcp-operation', { confirmUndo: true });
  return { effect: res.effect.name };
});

await step('combat: create, roll initiative, advance, cleanup', async () => {
  const combat = await control.callTool('create-document', { documentType: 'Combat', data: { scene: null } });
  const combatId = combat?.document?.id;
  if (!combatId) throw new Error('No combat id');
  const actorId = actorUuid.split('.').pop();
  await control.callTool('create-embedded-document', {
    parentUuid: `Combat.${combatId}`,
    embeddedType: 'Combatant',
    data: { actorId },
  });
  const rolled = await control.callTool('roll-initiative', { combatRef: { id: combatId }, mode: 'all' });
  if (!rolled?.order?.length) throw new Error('No initiative order returned');
  if (typeof rolled.order[0].initiative !== 'number') throw new Error('Initiative not rolled');
  await control.callTool('delete-document', { ref: { documentType: 'Combat', id: combatId }, confirmDeletion: true });
  return { order: rolled.order };
});

await step('events: chat message produces a bridge event', async () => {
  const baseline = await control.callTool('get-recent-events', { limit: 1 });
  const sinceSeq = baseline?.latestSeq ?? 0;
  await control.callTool('create-document', {
    documentType: 'ChatMessage',
    data: { content: 'Smoke test event ping' },
  });
  const waited = await control.callTool('wait-for-event', { sinceSeq, types: ['chat-message'], timeoutMs: 8000 });
  if (!waited?.matched) throw new Error('chat-message event not received within 8s');
  return { events: waited.events.map(e => e.type) };
});

await step('get-roll-results returns cleanly', async () => {
  const res = await control.callTool('get-roll-results', { limit: 3 });
  if (typeof res?.count !== 'number') throw new Error('No count in response');
  return { count: res.count };
});

await step('build-actors-from-spec creates a party under one undo group', async () => {
  const res = await control.callTool('build-actors-from-spec', {
    specs: [
      { name: 'Smoke Grunt A', type: 'npc' },
      { name: 'Smoke Grunt B', type: 'npc' },
    ],
  });
  if (res?.succeeded !== 2 || !res?.groupId) throw new Error(`Party build failed: ${JSON.stringify(res)}`);
  const undo = await control.callTool('undo-last-mcp-operation', { confirmUndo: true, groupId: res.groupId });
  const undone = undo?.undone?.filter(u => u.success)?.length ?? 0;
  if (undone !== 2) throw new Error(`Group undo reverted ${undone}/2 actors`);
  return { built: 2, groupUndone: undone };
});

await step('browse-assets lists the data tree', async () => {
  const res = await control.callTool('browse-assets', { directory: '' });
  if (!Array.isArray(res?.dirs)) throw new Error('No dirs array');
  return { dirs: res.dirs.length, files: res.files.length };
});

await step('upload-asset stores a tiny PNG and returns its path', async () => {
  // 1x1 transparent PNG
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const res = await control.callTool('upload-asset', { filename: 'smoke-test.png', base64: png });
  if (!res?.path) throw new Error('No path returned');
  return { path: res.path, bytes: res.bytes };
});

await step('build-scene-from-spec creates and deletes a scene', async () => {
  const res = await control.callTool('build-scene-from-spec', {
    spec: {
      name: 'Smoke Test Scene',
      width: 2000,
      height: 1400,
      lights: [{ x: 1000, y: 700, dim: 40, bright: 20 }],
    },
  });
  if (!res?.scene?.id) throw new Error('No scene id');
  await control.callTool('delete-document', { ref: { documentType: 'Scene', id: res.scene.id }, confirmDeletion: true });
  return { scene: res.scene.name, lights: 1 };
});

await step('get-bridge-logs tails the server log', async () => {
  const res = await control.callTool('get-bridge-logs', { lines: 5 });
  if (!res?.exists && !res?.lines?.length) throw new Error('Server log missing or empty');
  return { returned: res.returned };
});

await step('get-mcp-audit-log recorded this run', async () => {
  const res = await control.callTool('get-mcp-audit-log', { limit: 50 });
  if (!res?.entries?.length) throw new Error('Audit log empty');
  const ops = new Set(res.entries.map(e => e.operation));
  for (const expected of ['document.create', 'document.update', 'document.undo', 'actor.build']) {
    if (!ops.has(expected)) throw new Error(`Audit log missing operation ${expected}`);
  }
  return { total: res.totalStored };
});

// --- cleanup
await step('cleanup: delete actor and folder', async () => {
  await control.callTool('delete-document', { ref: { uuid: actorUuid }, confirmDeletion: true });
  await control.callTool('delete-folder', { ref: { documentType: 'Folder', id: folderId }, confirmDeletion: true });
  return { cleaned: true };
});

report();

function report() {
  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  console.log('\n=============================');
  console.log(`Result: ${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed) {
    for (const r of results.filter(r => !r.ok)) console.log(`  FAILED: ${r.name} — ${r.error}`);
  }
  control.close();
  process.exit(failed ? 1 : 0);
}
