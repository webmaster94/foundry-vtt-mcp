# Adding a game-system adapter

System adapters keep character output useful across Foundry systems without coupling generic tools to one system's data model. Compendium searches read live Foundry data and use generic bounded filters; adapters do not build or persist a duplicate search database.

## Adapter contract

Create `packages/mcp-server/src/systems/<system-id>/adapter.ts` and implement `SystemAdapter` from `../types.js`:

```typescript
import type { SystemAdapter, SystemMetadata } from '../types.js';

export class ExampleAdapter implements SystemAdapter {
  getMetadata(): SystemMetadata {
    return {
      id: 'other',
      name: 'example',
      displayName: 'Example System',
      version: '1.0.0',
      description: 'Character extraction for Example System',
      supportedFeatures: {
        characterStats: true,
        spellcasting: false,
        powerLevel: true,
      },
    };
  }

  canHandle(systemId: string): boolean {
    return systemId.toLowerCase() === 'example';
  }

  extractCharacterStats(actorData: any): any {
    const system = actorData.system ?? {};
    return {
      name: actorData.name,
      type: actorData.type,
      health: {
        current: system.health?.value ?? 0,
        max: system.health?.max ?? 0,
      },
      level: system.level?.value ?? system.level,
    };
  }

  extractBasicInfo(actorData: any): any {
    return {
      name: actorData.name,
      type: actorData.type,
      level: actorData.system?.level?.value,
    };
  }
}
```

`extractBasicInfo` is optional. Keep returned objects bounded and omit fields that do not exist instead of inventing system defaults. Treat actor payloads as untrusted external data and use optional chaining throughout.

If the new id should be a first-class supported system, add it to `SystemId` in `packages/mcp-server/src/systems/types.ts`. Otherwise the adapter can use the `other` metadata id while `canHandle` recognizes the Foundry id.

## Register the adapter

Register it beside the existing adapters during backend startup. The registry receives adapter instances and selects the first adapter whose `canHandle(game.system.id)` returns true. Do not add system routing to individual tools.

Export public adapter types from the system folder only when another module needs them. Avoid adding a persistent system-specific search cache or a new MCP tool solely for system detection.

## System-specific creation workflows

A system can expose a focused tool family when generic actor creation cannot express an important workflow, such as DSA5 archetypes. Follow the normal end-to-end capability path:

1. Add a GM-guarded Foundry query handler for writes.
2. Validate the request with a shared schema.
3. Add the MCP tool definition and dispatch.
4. Apply permission checks, audit recording, dry-run support, and an inverse operation where practical.
5. Add unit tests and a live smoke-test step.

Prefer extending an existing tool over adding a new advertised tool. The complete catalog must remain below the schema-size ceiling.

## Test checklist

- `canHandle` accepts the exact Foundry `game.system.id` and rejects unrelated ids.
- Missing or partial `actorData.system` does not throw.
- Character output maps real fixture paths for the installed system version.
- Resource current/max values and spellcasting fields are correct.
- Generic compendium search still works using live data and bounded limits.
- `npm run build` and `npm test` pass.
- A live `npm run smoke` run confirms Foundry API behavior before release.

Update this guide and the main README when support is user-visible, and keep all workspace/module versions synchronized for a release.
