import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');
const distRoot = path.join(repoRoot, 'packages', 'mcp-server', 'dist');
const backendSourcePath = path.join(repoRoot, 'packages', 'mcp-server', 'src', 'backend.ts');
const queriesSourcePath = path.join(repoRoot, 'packages', 'foundry-module', 'src', 'queries.ts');
const contractPath = path.join(scriptsDir, 'fork-feature-contract.json');

const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const failures = [];

const unique = values => [...new Set(values)];
const sorted = values => [...values].sort((left, right) => left.localeCompare(right));
const flattenRemovalGroups = groups => Object.values(groups).flat();

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return sorted(duplicates);
}

function assertContractList(label, values) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value)) {
    failures.push(`${label} must be an array of non-empty strings`);
    return;
  }
  const duplicates = findDuplicates(values);
  if (duplicates.length > 0) {
    failures.push(`${label} contains duplicates: ${duplicates.join(', ')}`);
  }
}

const baselineTools = contract.baseline.advertisedTools;
const baselineQueries = contract.baseline.queryHandlers;
const retiredTools = flattenRemovalGroups(contract.authorizedRemovals.advertisedTools);
const retiredQueries = flattenRemovalGroups(contract.authorizedRemovals.queryHandlers);

assertContractList('baseline.advertisedTools', baselineTools);
assertContractList('baseline.queryHandlers', baselineQueries);
assertContractList('authorizedRemovals.advertisedTools', retiredTools);
assertContractList('authorizedRemovals.queryHandlers', retiredQueries);

for (const retiredTool of retiredTools) {
  if (!baselineTools.includes(retiredTool)) {
    failures.push(`authorized removed tool was not advertised at baseline: ${retiredTool}`);
  }
}
for (const retiredQuery of retiredQueries) {
  if (!baselineQueries.includes(retiredQuery)) {
    failures.push(`authorized removed query was not registered at baseline: ${retiredQuery}`);
  }
}

const toolCatalogAvailable = fs.existsSync(distRoot);
if (!toolCatalogAvailable) {
  failures.push(
    `server build output is missing at ${distRoot}; run "npm run build:server" before this check`
  );
}

const logger = {
  child() {
    return this;
  },
  debug() {},
  error() {},
  info() {},
  warn() {},
};
const foundryClient = {};
const registry = {};
const systemRegistry = {};
const defaultOptions = { foundryClient, registry, logger, systemRegistry };

// Keep this list aligned with backend.ts's allTools catalog. The backend source
// fragments below make a dropped catalog provider fail even if its class still
// exists and still returns definitions.
const providers = [
  {
    label: 'CharacterTools',
    module: 'tools/character.js',
    exportName: 'CharacterTools',
    backendFragments: ['...characterTools.getToolDefinitions()'],
  },
  {
    label: 'CompendiumTools',
    module: 'tools/compendium.js',
    exportName: 'CompendiumTools',
    backendFragments: ['...compendiumTools.getToolDefinitions()'],
  },
  {
    label: 'SceneTools',
    module: 'tools/scene.js',
    exportName: 'SceneTools',
    backendFragments: ['...sceneTools.getToolDefinitions()'],
  },
  {
    label: 'ActorCreationTools',
    module: 'tools/actor-creation.js',
    exportName: 'ActorCreationTools',
    backendFragments: ['...actorCreationTools.getToolDefinitions()'],
  },
  {
    label: 'DSA5CharacterCreator',
    module: 'systems/dsa5/character-creator.js',
    exportName: 'DSA5CharacterCreator',
    backendFragments: ['...dsa5CharacterCreator.getToolDefinitions()'],
  },
  {
    label: 'DnD5eAddFeatureTool',
    module: 'tools/dnd5e/add-feature.js',
    exportName: 'DnD5eAddFeatureTool',
    backendFragments: ['...dnd5eAddFeatureTool.getToolDefinitions()'],
  },
  {
    label: 'DnD5eNpcTools',
    module: 'tools/dnd5e/npc.js',
    exportName: 'DnD5eNpcTools',
    backendFragments: ['...dnd5eNpcTools.getToolDefinitions()'],
  },
  {
    label: 'DnD5eFeaturesFromCompendiumTools',
    module: 'tools/dnd5e/features.js',
    exportName: 'DnD5eFeaturesFromCompendiumTools',
    backendFragments: ['...dnd5eFeaturesFromCompendiumTools.getToolDefinitions()'],
  },
  {
    label: 'QuestCreationTools',
    module: 'tools/quest-creation.js',
    exportName: 'QuestCreationTools',
    backendFragments: ['...questCreationTools.getToolDefinitions()'],
  },
  {
    label: 'DiceRollTools',
    module: 'tools/dice-roll.js',
    exportName: 'DiceRollTools',
    backendFragments: ['...diceRollTools.getToolDefinitions()'],
  },
  {
    label: 'CampaignManagementTools',
    module: 'tools/campaign-management.js',
    exportName: 'CampaignManagementTools',
    create: Constructor => new Constructor(foundryClient, logger),
    backendFragments: ['...campaignManagementTools.getToolDefinitions()'],
  },
  {
    label: 'OwnershipTools',
    module: 'tools/ownership.js',
    exportName: 'OwnershipTools',
    backendFragments: ['...ownershipTools.getToolDefinitions()'],
  },
  {
    label: 'WFRP4eUpdateActorTools',
    module: 'tools/wfrp4e/update-actor.js',
    exportName: 'WFRP4eUpdateActorTools',
    backendFragments: ['...wfrp4eUpdateActorTools.getToolDefinitions()'],
  },
  {
    label: 'WFRP4eAddItemsTools',
    module: 'tools/wfrp4e/add-items.js',
    exportName: 'WFRP4eAddItemsTools',
    backendFragments: ['...wfrp4eAddItemsTools.getToolDefinitions()'],
  },
  {
    label: 'TokenManipulationTools',
    module: 'tools/token-manipulation.js',
    exportName: 'TokenManipulationTools',
    backendFragments: ['...tokenManipulationTools.getToolDefinitions()'],
  },
  {
    label: 'BrowserConsoleTools',
    module: 'tools/browser-console.js',
    exportName: 'BrowserConsoleTools',
    backendFragments: ['...browserConsoleTools.getToolDefinitions()'],
  },
  {
    label: 'DocumentManagementTools',
    module: 'tools/document-management.js',
    exportName: 'DocumentManagementTools',
    backendFragments: ['...documentToolDefinitions'],
    backendSourceFragments: [
      'const documentToolDefinitions = documentManagementTools.getToolDefinitions()',
    ],
  },
  {
    label: 'MacroManagementTools',
    module: 'tools/macro-management.js',
    exportName: 'MacroManagementTools',
    backendFragments: ['...macroToolDefinitions'],
    backendSourceFragments: [
      'const macroToolDefinitions = macroManagementTools.getToolDefinitions()',
    ],
  },
  {
    label: 'FoundryScriptTools',
    module: 'tools/foundry-script.js',
    exportName: 'FoundryScriptTools',
    backendFragments: ['...foundryScriptToolDefinitions'],
    backendSourceFragments: [
      'const foundryScriptToolDefinitions = foundryScriptTools.getToolDefinitions()',
    ],
  },
  {
    label: 'ServerManagementTools',
    module: 'tools/server-management.js',
    exportName: 'ServerManagementTools',
    backendFragments: ['...serverManagementTools.getToolDefinitions()'],
  },
  {
    label: 'RecipeTools',
    module: 'tools/recipes.js',
    exportName: 'RecipeTools',
    backendFragments: ['...recipeTools.getToolDefinitions()'],
  },
  {
    label: 'GameActionTools',
    module: 'tools/game-actions.js',
    exportName: 'GameActionTools',
    backendFragments: ['...gameActionTools.getToolDefinitions()'],
  },
];

const providerCatalog = new Map();
const currentTools = [];

if (toolCatalogAvailable) {
  for (const provider of providers) {
    try {
      const moduleUrl = pathToFileURL(path.join(distRoot, provider.module)).href;
      const loadedModule = await import(moduleUrl);
      const Constructor = loadedModule[provider.exportName];
      if (typeof Constructor !== 'function') {
        failures.push(`${provider.label} is not exported by ${provider.module}`);
        continue;
      }

      const instance = provider.create
        ? provider.create(Constructor)
        : new Constructor(defaultOptions);
      const definitions = instance.getToolDefinitions();
      if (!Array.isArray(definitions)) {
        failures.push(`${provider.label}.getToolDefinitions() did not return an array`);
        continue;
      }

      const names = definitions.map(definition => definition?.name);
      const invalidNames = names.filter(name => typeof name !== 'string' || !name);
      if (invalidNames.length > 0) {
        failures.push(`${provider.label} returned a tool definition without a valid name`);
      }
      providerCatalog.set(provider.label, names);
      currentTools.push(...names);
    } catch (error) {
      failures.push(
        `could not load ${provider.label} from ${provider.module}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

const toolDuplicates = findDuplicates(currentTools);
if (toolDuplicates.length > 0) {
  failures.push(
    `the advertised MCP catalog contains duplicate names: ${toolDuplicates.join(', ')}`
  );
}

const backendSource = fs.readFileSync(backendSourcePath, 'utf8');
const normalizedBackendSource = backendSource.replace(/\s+/g, '');
for (const provider of providers) {
  for (const fragment of provider.backendSourceFragments ?? []) {
    if (!normalizedBackendSource.includes(fragment.replace(/\s+/g, ''))) {
      failures.push(`backend.ts no longer constructs the ${provider.label} catalog provider`);
    }
  }
}
const allToolsStart = backendSource.indexOf('const allTools = [');
const allToolsEnd = backendSource.indexOf('const additionalToolHandlers', allToolsStart);
if (allToolsStart === -1 || allToolsEnd === -1) {
  failures.push('could not locate backend.ts allTools catalog');
} else {
  const normalizedAllToolsBlock = backendSource
    .slice(allToolsStart, allToolsEnd)
    .replace(/\s+/g, '');
  for (const provider of providers) {
    for (const fragment of provider.backendFragments) {
      if (!normalizedAllToolsBlock.includes(fragment.replace(/\s+/g, ''))) {
        failures.push(`backend.ts no longer advertises the ${provider.label} catalog provider`);
      }
    }
  }
  if (normalizedAllToolsBlock.includes('mapGenerationTools.getToolDefinitions()')) {
    failures.push('backend.ts still advertises the retired AI map-generation provider');
  }
}

function extractRegisteredQueries(sourceText) {
  const sourceFile = ts.createSourceFile(
    queriesSourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const registrations = [];
  const classMethods = new Set();

  function visit(node) {
    if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      classMethods.add(node.name.text);
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      ts.isPropertyAccessExpression(node.left.expression) &&
      ts.isIdentifier(node.left.expression.expression) &&
      node.left.expression.expression.text === 'CONFIG' &&
      node.left.expression.name.text === 'queries' &&
      node.left.argumentExpression
    ) {
      const argumentText = node.left.argumentExpression.getText(sourceFile);
      const nameMatch = argumentText.match(/^`\$\{modulePrefix\}\.([^`]+)`$/);
      if (nameMatch) {
        let handlerMethod = null;
        if (
          ts.isCallExpression(node.right) &&
          ts.isPropertyAccessExpression(node.right.expression) &&
          node.right.expression.name.text === 'bind' &&
          ts.isPropertyAccessExpression(node.right.expression.expression) &&
          node.right.expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
          handlerMethod = node.right.expression.expression.name.text;
        }
        registrations.push({ name: nameMatch[1], handlerMethod });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { registrations, classMethods };
}

const { registrations, classMethods } = extractRegisteredQueries(
  fs.readFileSync(queriesSourcePath, 'utf8')
);
const currentQueries = registrations.map(registration => registration.name);
const queryDuplicates = findDuplicates(currentQueries);
if (queryDuplicates.length > 0) {
  failures.push(`CONFIG.queries contains duplicate registrations: ${queryDuplicates.join(', ')}`);
}

for (const registration of registrations) {
  if (!registration.handlerMethod) {
    failures.push(
      `CONFIG.queries registration ${registration.name} is not bound to a handler method`
    );
  } else if (!classMethods.has(registration.handlerMethod)) {
    failures.push(
      `CONFIG.queries registration ${registration.name} references missing method ${registration.handlerMethod}`
    );
  }
}

const retainedBaselineTools = baselineTools.filter(name => !retiredTools.includes(name));
const retainedBaselineQueries = baselineQueries.filter(name => !retiredQueries.includes(name));
const missingTools = retainedBaselineTools.filter(name => !currentTools.includes(name));
const missingQueries = retainedBaselineQueries.filter(name => !currentQueries.includes(name));
const resurrectedTools = retiredTools.filter(name => currentTools.includes(name));
const resurrectedQueries = retiredQueries.filter(name => currentQueries.includes(name));

if (toolCatalogAvailable && missingTools.length > 0) {
  failures.push(`protected baseline MCP tools are missing: ${sorted(missingTools).join(', ')}`);
}
if (missingQueries.length > 0) {
  failures.push(
    `protected baseline CONFIG.queries handlers are missing: ${sorted(missingQueries).join(', ')}`
  );
}
if (toolCatalogAvailable && resurrectedTools.length > 0) {
  failures.push(`retired MCP tools are advertised again: ${sorted(resurrectedTools).join(', ')}`);
}
if (resurrectedQueries.length > 0) {
  failures.push(
    `retired CONFIG.queries handlers are registered again: ${sorted(resurrectedQueries).join(', ')}`
  );
}

for (const relocation of contract.requiredRelocations) {
  const providerTools = providerCatalog.get(relocation.provider) ?? [];
  if (toolCatalogAvailable && !providerTools.includes(relocation.tool)) {
    failures.push(
      `${relocation.tool} is not provided by relocated provider ${relocation.provider}`
    );
  }
  if (!currentQueries.includes(relocation.queryHandler)) {
    failures.push(
      `${relocation.tool} lost its CONFIG.queries handler ${relocation.queryHandler} after relocation`
    );
  }
}

if (failures.length > 0) {
  console.error(
    `[Fork Feature Contract] FAIL against ${contract.baseline.tag} (${contract.baseline.commit})`
  );
  for (const failure of unique(failures)) console.error(`- ${failure}`);
  process.exit(1);
}

const addedTools = currentTools.filter(name => !baselineTools.includes(name));
const addedQueries = currentQueries.filter(name => !baselineQueries.includes(name));
console.log(
  `[Fork Feature Contract] PASS against ${contract.baseline.tag} (${contract.baseline.commit})`
);
console.log(
  `- MCP tools: ${baselineTools.length} baseline = ${retainedBaselineTools.length} retained + ${retiredTools.length} authorized removals; ${currentTools.length} currently advertised`
);
console.log(
  `- CONFIG.queries: ${baselineQueries.length} baseline = ${retainedBaselineQueries.length} retained + ${retiredQueries.length} authorized removals; ${currentQueries.length} currently registered`
);
console.log(`- Authorized tool removals: ${sorted(retiredTools).join(', ')}`);
console.log(`- Authorized query removals: ${sorted(retiredQueries).join(', ')}`);
console.log(
  '- Relocations: list-scenes and switch-scene are advertised by SceneTools and registered'
);
if (addedTools.length > 0)
  console.log(`- New tools since baseline: ${sorted(addedTools).join(', ')}`);
if (addedQueries.length > 0)
  console.log(`- New queries since baseline: ${sorted(addedQueries).join(', ')}`);
