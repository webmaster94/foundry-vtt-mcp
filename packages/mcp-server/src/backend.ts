import * as fs from 'fs';

import * as os from 'os';

import * as path from 'path';

import * as net from 'net';
import { randomUUID } from 'crypto';

import {
  acquireBackendLockFile,
  parseBackendLockIdentity,
  type BackendLockIdentity,
} from './lock.js';

import { config } from './config.js';

import { Logger } from './logger.js';

import { ServerRegistry, runWithServer } from './server-registry.js';

import { ServerManagementTools } from './tools/server-management.js';

import { RecipeTools } from './tools/recipes.js';

import { GameActionTools } from './tools/game-actions.js';

import { CharacterTools } from './tools/character.js';

import { CompendiumTools } from './tools/compendium.js';

import { SceneTools } from './tools/scene.js';

import { ActorCreationTools } from './tools/actor-creation.js';

import { QuestCreationTools } from './tools/quest-creation.js';

import { DiceRollTools } from './tools/dice-roll.js';

import { CampaignManagementTools } from './tools/campaign-management.js';

import { OwnershipTools } from './tools/ownership.js';
import { WFRP4eUpdateActorTools } from './tools/wfrp4e/update-actor.js';
import { WFRP4eAddItemsTools } from './tools/wfrp4e/add-items.js';

import { TokenManipulationTools } from './tools/token-manipulation.js';

import { BrowserConsoleTools } from './tools/browser-console.js';

import { DocumentManagementTools } from './tools/document-management.js';

import { MacroManagementTools } from './tools/macro-management.js';

import { FoundryScriptTools } from './tools/foundry-script.js';

import { DSA5CharacterCreator } from './systems/dsa5/character-creator.js';

import { DnD5eAddFeatureTool } from './tools/dnd5e/add-feature.js';
import { DnD5eNpcTools } from './tools/dnd5e/npc.js';
import { DnD5eFeaturesFromCompendiumTools } from './tools/dnd5e/features.js';
import { CONTROL_HOST, CONTROL_PORT, type BackendPingResult } from './control-protocol.js';
import { DesktopControlService, isDesktopControlMethod } from './desktop-control-service.js';

const LOCK_FILE = path.join(os.tmpdir(), 'foundry-mcp-backend.lock');

const backendStartedAt = new Date().toISOString();
const backendInstanceId = randomUUID();
const backendEntryPath = path.resolve(process.argv[1] || '');
let backendEntrySig = '';
try {
  const entryStat = fs.statSync(backendEntryPath);
  backendEntrySig = `${entryStat.size}:${Math.round(entryStat.mtimeMs)}`;
} catch {
  // A missing signature only disables build-freshness comparison.
}

const backendIdentity: BackendLockIdentity = {
  pid: process.pid,
  instanceId: backendInstanceId,
  startedAt: backendStartedAt,
  entryPath: backendEntryPath,
};

let lockFd: number | null = null;

async function acquireLock(): Promise<boolean> {
  try {
    const acquisition = await acquireBackendLockFile(LOCK_FILE, backendIdentity);
    if (!acquisition.acquired) {
      console.error(`Backend already running with PID ${acquisition.existing.pid}`);
      return false;
    }
    lockFd = acquisition.fd;

    console.error(`Acquired backend lock with PID ${process.pid}`);

    return true;
  } catch (error) {
    console.error('Failed to acquire backend lock:', error);

    return false;
  }
}

function releaseLock(): void {
  try {
    if (lockFd !== null) {
      try {
        fs.closeSync(lockFd);
      } catch {}
      lockFd = null;
    }

    if (fs.existsSync(LOCK_FILE)) {
      try {
        const current = parseBackendLockIdentity(fs.readFileSync(LOCK_FILE, 'utf8'));
        if (current?.pid === process.pid && current.instanceId === backendInstanceId) {
          fs.unlinkSync(LOCK_FILE);
        }
      } catch {}
    }
  } catch (error) {
    console.error('Failed to release backend lock:', error);
  }
}

async function startBackend(): Promise<void> {
  // Logger: file output allowed; avoid stdout noise

  const logger = new Logger({
    level: config.logLevel,

    format: config.logFormat,

    enableConsole: false,

    enableFile: true,

    filePath: path.join(os.tmpdir(), 'foundry-mcp-server', 'mcp-server.log'),
  });

  logger.info('Starting Foundry MCP Backend', {
    version: config.server.version,

    entrySig: backendEntrySig,

    foundryHost: config.foundry.host,

    foundryPort: config.foundry.port,
  });

  // Initialize Foundry server registry (named connection profiles) and the
  // routing client facade all tools share. The active profile is switched at
  // runtime via the use-foundry-server tool.

  const serverRegistry = new ServerRegistry(config, logger);

  const foundryClient = serverRegistry.routingClient;

  const serverManagementTools = new ServerManagementTools({ registry: serverRegistry, logger });

  const getPingResult = (): BackendPingResult => ({
    ok: true,
    pid: process.pid,
    version: config.server.version,
    startedAt: backendStartedAt,
    entrySig: backendEntrySig,
    instanceId: backendInstanceId,
    entryPath: backendEntryPath,
  });

  const desktopControl = new DesktopControlService(serverRegistry, config, logger, getPingResult);

  const recipeTools = new RecipeTools({ logger });

  // Initialize system registry and register adapters
  const { getSystemRegistry } = await import('./systems/index.js');
  const { DnD5eAdapter } = await import('./systems/dnd5e/adapter.js');
  const { PF2eAdapter } = await import('./systems/pf2e/adapter.js');
  const { DSA5Adapter } = await import('./systems/dsa5/adapter.js');
  const { CosmereRpgAdapter } = await import('./systems/cosmere-rpg/adapter.js');
  const { WFRP4eAdapter } = await import('./systems/wfrp4e/adapter.js');
  const { MGT2eAdapter } = await import('./systems/mgt2e/adapter.js');

  const systemRegistry = getSystemRegistry(logger);
  systemRegistry.register(new DnD5eAdapter());
  systemRegistry.register(new PF2eAdapter());
  systemRegistry.register(new DSA5Adapter());
  systemRegistry.register(new CosmereRpgAdapter());
  systemRegistry.register(new WFRP4eAdapter());
  systemRegistry.register(new MGT2eAdapter());

  logger.info('System registry initialized', {
    supportedSystems: systemRegistry.getSupportedSystems(),
  });

  const characterTools = new CharacterTools({ foundryClient, logger, systemRegistry });

  const compendiumTools = new CompendiumTools({ foundryClient, logger, systemRegistry });

  const gameActionTools = new GameActionTools({
    foundryClient,
    registry: serverRegistry,
    logger,
    systemRegistry,
  });

  const sceneTools = new SceneTools({ foundryClient, logger });

  const actorCreationTools = new ActorCreationTools({ foundryClient, logger });

  const dsa5CharacterCreator = new DSA5CharacterCreator({ foundryClient, logger });

  const dnd5eAddFeatureTool = new DnD5eAddFeatureTool({ foundryClient, logger });
  const dnd5eNpcTools = new DnD5eNpcTools({ foundryClient, logger });
  const dnd5eFeaturesFromCompendiumTools = new DnD5eFeaturesFromCompendiumTools({
    foundryClient,
    logger,
  });

  const questCreationTools = new QuestCreationTools({ foundryClient, logger });

  const diceRollTools = new DiceRollTools({ foundryClient, logger });

  const campaignManagementTools = new CampaignManagementTools(foundryClient, logger);

  const ownershipTools = new OwnershipTools({ foundryClient, logger });

  const tokenManipulationTools = new TokenManipulationTools({ foundryClient, logger });

  const browserConsoleTools = new BrowserConsoleTools({ foundryClient, logger });

  const documentManagementTools = new DocumentManagementTools({
    foundryClient,
    logger,
    systemRegistry,
  });

  const macroManagementTools = new MacroManagementTools({ foundryClient, logger });

  const foundryScriptTools = new FoundryScriptTools({ foundryClient, logger });

  const wfrp4eUpdateActorTools = new WFRP4eUpdateActorTools({ foundryClient, logger });
  const wfrp4eAddItemsTools = new WFRP4eAddItemsTools({ foundryClient, logger });

  const documentToolDefinitions = documentManagementTools.getToolDefinitions();
  const macroToolDefinitions = macroManagementTools.getToolDefinitions();
  const foundryScriptToolDefinitions = foundryScriptTools.getToolDefinitions();

  const allTools = [
    ...characterTools.getToolDefinitions(),

    ...compendiumTools.getToolDefinitions(),

    ...sceneTools.getToolDefinitions(),

    ...actorCreationTools.getToolDefinitions(),

    ...dsa5CharacterCreator.getToolDefinitions(),

    ...dnd5eAddFeatureTool.getToolDefinitions(),
    ...dnd5eNpcTools.getToolDefinitions(),
    ...dnd5eFeaturesFromCompendiumTools.getToolDefinitions(),

    ...questCreationTools.getToolDefinitions(),

    ...diceRollTools.getToolDefinitions(),

    ...campaignManagementTools.getToolDefinitions(),

    ...ownershipTools.getToolDefinitions(),

    ...wfrp4eUpdateActorTools.getToolDefinitions(),

    ...wfrp4eAddItemsTools.getToolDefinitions(),

    ...tokenManipulationTools.getToolDefinitions(),

    ...browserConsoleTools.getToolDefinitions(),

    ...documentToolDefinitions,

    ...macroToolDefinitions,

    ...foundryScriptToolDefinitions,

    ...serverManagementTools.getToolDefinitions(),

    ...recipeTools.getToolDefinitions(),

    ...gameActionTools.getToolDefinitions(),
  ];

  const additionalToolHandlers: Record<string, (args: any) => Promise<any>> = {};
  // Dispatch names, not advertised definitions: keeps the unadvertised legacy
  // wrapper tools callable (context budget keeps them out of the catalog)
  for (const name of documentManagementTools.getDispatchToolNames()) {
    additionalToolHandlers[name] = (args: any) =>
      documentManagementTools.handleToolCall(name, args);
  }
  for (const tool of macroToolDefinitions) {
    additionalToolHandlers[tool.name] = (args: any) =>
      macroManagementTools.handleToolCall(tool.name, args);
  }
  for (const tool of foundryScriptToolDefinitions) {
    additionalToolHandlers[tool.name] = (args: any) =>
      foundryScriptTools.handleToolCall(tool.name, args);
  }
  for (const tool of serverManagementTools.getToolDefinitions()) {
    additionalToolHandlers[tool.name] = (args: any) =>
      serverManagementTools.handleToolCall(tool.name, args);
  }
  for (const tool of recipeTools.getToolDefinitions()) {
    additionalToolHandlers[tool.name] = (args: any) => recipeTools.handleToolCall(tool.name, args);
  }
  for (const tool of gameActionTools.getToolDefinitions()) {
    additionalToolHandlers[tool.name] = (args: any) =>
      gameActionTools.handleToolCall(tool.name, args);
  }

  // Start Foundry connectors for every configured server profile

  await serverRegistry.connectAll();
  serverRegistry.refreshCapabilityCaches();
  const capabilityRefreshTimer = setInterval(() => serverRegistry.refreshCapabilityCaches(), 5_000);
  capabilityRefreshTimer.unref?.();

  let shutdownPromise: Promise<void> | null = null;
  const shutdownBackend = (reason: string, exitCode = 0): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      logger.info('Shutting down Foundry MCP backend', { reason });
      clearInterval(capabilityRefreshTimer);
      let forced = false;
      await Promise.race([
        serverRegistry.disconnectAll(),
        new Promise<void>(resolve => {
          const timeout = setTimeout(() => {
            forced = true;
            resolve();
          }, 10_000);
          timeout.unref?.();
        }),
      ]);
      if (forced) logger.warn('Timed out waiting for all Foundry connectors to stop');
      releaseLock();
      process.exit(exitCode);
    })();

    return shutdownPromise;
  };

  // Control channel (TCP JSON-lines)

  const server = net.createServer(socket => {
    socket.setEncoding('utf8');

    let buffer = '';

    socket.on('data', async (chunk: string) => {
      buffer += chunk;

      let idx: number;

      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();

        buffer = buffer.slice(idx + 1);

        if (!line) continue;

        let requestId: string | undefined;
        try {
          const msg = JSON.parse(line) as { id: string; method: string; params?: any };
          requestId = typeof msg.id === 'string' ? msg.id : undefined;

          if (msg.method === 'ping') {
            socket.write(
              JSON.stringify({
                id: msg.id,
                result: getPingResult(),
              }) + '\n'
            );

            continue;
          }

          if (isDesktopControlMethod(msg.method)) {
            const result = await desktopControl.handle(msg.method, msg.params);
            socket.write(JSON.stringify({ id: msg.id, result }) + '\n');
            continue;
          }

          if (msg.method === 'shutdown') {
            // Graceful daemon shutdown, requested by a wrapper that detected a
            // newer build on disk (or by npm run stop)
            logger.info('Shutdown requested via control channel');

            socket.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + '\n');

            setTimeout(() => void shutdownBackend('control-channel request'), 150);

            continue;
          }

          if (msg.method === 'list_tools') {
            socket.write(JSON.stringify({ id: msg.id, result: { tools: allTools } }) + '\n');

            continue;
          }

          if (msg.method === 'call_tool') {
            const { name, args: rawArgs } = (msg.params || {}) as { name: string; args?: any };

            // Universal per-call server override: any tool may pass
            // `server: "<profile>"` to target a specific Foundry instance
            // for just that call, without changing the active server.
            let args = rawArgs;
            let serverOverride: string | undefined;
            if (
              rawArgs &&
              typeof rawArgs.server === 'string' &&
              name !== 'use-foundry-server' &&
              name !== 'list-foundry-servers'
            ) {
              serverOverride = rawArgs.server;
              const { server: _server, ...rest } = rawArgs;
              args = rest;
            }

            const dispatch = async (): Promise<any> => {
              let result: any;

              const additionalToolHandler = additionalToolHandlers[name];

              if (additionalToolHandler) {
                result = await additionalToolHandler(args);
              } else
                switch (name) {
                  // Character tools

                  case 'get-character':
                    result = await characterTools.handleGetCharacter(args);

                    break;

                  case 'list-characters':
                    result = await characterTools.handleListCharacters(args);

                    break;

                  case 'get-character-entity':
                    result = await characterTools.handleGetCharacterEntity(args);

                    break;

                  case 'use-item':
                    result = await characterTools.handleUseItem(args);

                    break;

                  case 'search-character-items':
                    result = await characterTools.handleSearchCharacterItems(args);

                    break;

                  case 'manage-world-items':
                    result = await characterTools.handleManageWorldItems(args);

                    break;

                  // Compendium tools

                  case 'search-compendium':
                    result = await compendiumTools.handleSearchCompendium(args);

                    break;

                  case 'get-compendium-item':
                    result = await compendiumTools.handleGetCompendiumItem(args);

                    break;

                  case 'list-compendium-packs':
                    result = await compendiumTools.handleListCompendiumPacks(args);

                    break;

                  // Scene tools

                  case 'get-current-scene':
                    result = await sceneTools.handleGetCurrentScene(args);

                    break;

                  case 'get-world-info':
                    result = await sceneTools.handleGetWorldInfo(args);

                    break;

                  // Actor creation tools

                  case 'create-actor-from-compendium':
                    result = await actorCreationTools.handleCreateActorFromCompendium(args);

                    break;

                  case 'get-compendium-entry-full':
                    result = await actorCreationTools.handleGetCompendiumEntryFull(args);

                    break;

                  case 'wfrp4e-update-actor':
                    result = await wfrp4eUpdateActorTools.handleUpdateActor(args);

                    break;

                  case 'wfrp4e-add-items':
                    result = await wfrp4eAddItemsTools.handleAddItems(args);

                    break;

                  // DSA5 character creation tools

                  case 'create-dsa5-character-from-archetype':
                    result = await dsa5CharacterCreator.handleCreateCharacterFromArchetype(args);

                    break;

                  case 'list-dsa5-archetypes':
                    result = await dsa5CharacterCreator.handleListArchetypes(args);

                    break;

                  // D&D 5e tools

                  case 'dnd5e-add-feature':
                    result = await dnd5eAddFeatureTool.handleAddFeature(args);

                    break;

                  case 'dnd5e-create-npc':
                    result = await dnd5eNpcTools.handleCreateNpc(args);

                    break;

                  case 'dnd5e-add-features-from-compendium':
                    result =
                      await dnd5eFeaturesFromCompendiumTools.handleAddFeaturesFromCompendium(args);

                    break;

                  // Quest creation tools

                  case 'create-quest-journal':
                    result = await questCreationTools.handleCreateQuestJournal(args);

                    break;

                  case 'link-quest-to-npc':
                    result = await questCreationTools.handleLinkQuestToNPC(args);

                    break;

                  case 'update-quest-journal':
                    result = await questCreationTools.handleUpdateQuestJournal(args);

                    break;

                  case 'list-journals':
                    result = await questCreationTools.handleListJournals(args);

                    break;

                  case 'search-journals':
                    result = await questCreationTools.handleSearchJournals(args);

                    break;

                  // Dice roll tools

                  case 'request-player-rolls':
                    result = await diceRollTools.handleRequestPlayerRolls(args);

                    break;

                  // Campaign management tools

                  case 'create-campaign-dashboard':
                    result = await campaignManagementTools.handleCreateCampaignDashboard(args);

                    break;

                  // Ownership tools

                  case 'assign-actor-ownership':
                    result = await ownershipTools.handleToolCall('assign-actor-ownership', args);

                    break;

                  case 'remove-actor-ownership':
                    result = await ownershipTools.handleToolCall('remove-actor-ownership', args);

                    break;

                  case 'list-actor-ownership':
                    result = await ownershipTools.handleToolCall('list-actor-ownership', args);

                    break;

                  // Token manipulation tools

                  case 'move-token':
                    result = await tokenManipulationTools.handleMoveToken(args);

                    break;

                  case 'update-token':
                    result = await tokenManipulationTools.handleUpdateToken(args);

                    break;

                  case 'delete-tokens':
                    result = await tokenManipulationTools.handleDeleteTokens(args);

                    break;

                  case 'get-token-details':
                    result = await tokenManipulationTools.handleGetTokenDetails(args);

                    break;

                  case 'toggle-token-condition':
                    result = await tokenManipulationTools.handleToggleTokenCondition(args);

                    break;

                  case 'get-available-conditions':
                    result = await tokenManipulationTools.handleGetAvailableConditions(args);

                    break;

                  // Browser console tools

                  case 'get-browser-console':
                    result = await browserConsoleTools.handleGetBrowserConsole(args);

                    break;

                  case 'clear-browser-console':
                    result = await browserConsoleTools.handleClearBrowserConsole(args);

                    break;

                  case 'get-browser-console-status':
                    result = await browserConsoleTools.handleGetBrowserConsoleStatus(args);

                    break;

                  // Scene tools

                  case 'list-scenes':
                    result = await sceneTools.listScenes(args);

                    break;

                  case 'switch-scene':
                    result = await sceneTools.switchScene(args);

                    break;

                  default:
                    throw new Error(`Unknown tool: ${name}`);
                }

              return result;
            };

            try {
              const changesGlobalRouting =
                name === 'use-foundry-server' ||
                name === 'list-foundry-servers' ||
                name === 'reload-foundry-servers-config' ||
                name === 'reconnect-foundry-server';
              // Pin every ordinary call to one profile for its whole lifetime.
              // Otherwise a concurrent use-foundry-server call could move a
              // multi-step read/normalize/write operation midway through it.
              const pinnedServer =
                serverOverride ??
                (changesGlobalRouting ? undefined : serverRegistry.getActiveName());
              const result = pinnedServer
                ? await runWithServer(pinnedServer, dispatch)
                : await dispatch();

              const payload = {
                content: [
                  {
                    type: 'text',
                    text: typeof result === 'string' ? result : JSON.stringify(result),
                  },
                ],
              };

              socket.write(JSON.stringify({ id: msg.id, result: payload }) + '\n');
            } catch (e: any) {
              const errorMessage = e instanceof Error ? e.message : 'Unknown error occurred';
              const errorCode = (e as any)?.code;

              socket.write(
                JSON.stringify({
                  id: msg.id,
                  result: {
                    content: [{ type: 'text', text: `Error: ${errorMessage}` }],
                    isError: true,
                    ...(errorCode ? { errorCode } : {}),
                  },
                }) + '\n'
              );
            }

            continue;
          }

          // Unknown method

          socket.write(JSON.stringify({ id: msg.id, error: { message: 'Unknown method' } }) + '\n');
        } catch (e: any) {
          try {
            socket.write(
              JSON.stringify({
                ...(requestId ? { id: requestId } : {}),
                error: { message: e?.message || 'Bad request' },
              }) + '\n'
            );
          } catch {}
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(CONTROL_PORT, CONTROL_HOST, () => {
      logger.info(`Backend control channel listening on ${CONTROL_HOST}:${CONTROL_PORT}`);

      resolve();
    });

    server.on('error', reject);
  });

  // Shutdown hooks

  process.on('SIGINT', () => void shutdownBackend('SIGINT'));

  process.on('SIGTERM', () => void shutdownBackend('SIGTERM'));
}

// The backend is a detached daemon entry, not the stdio MCP wrapper. If a
// verified singleton already owns the lock, this duplicate can exit cleanly;
// wrappers remain alive and connect to the existing control endpoint.
(async function main() {
  // Lock acquisition is the first asynchronous operation. It briefly waits
  // for a simultaneous creator to finish writing its lock identity.
  const hasLock = await acquireLock();
  if (!hasLock) {
    return;
  }

  process.on('exit', releaseLock);

  try {
    await startBackend();
  } catch (e: any) {
    console.error('Failed to start backend:', e?.message || e);

    releaseLock();

    process.exit(1);
  }
})();
