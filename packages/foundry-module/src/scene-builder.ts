import { auditService } from './audit-service.js';
import { documentService } from './document-service.js';
import { permissionManager } from './permissions.js';

/**
 * Build a complete scene from a declarative spec: background, grid, lights,
 * walls, and tokens placed by actor name — the scene-side sibling of
 * build-actor-from-spec.
 */

export interface SceneSpec {
  name: string;
  /** Image path for the background (use browse-assets / upload-asset to find one). */
  background?: string;
  width?: number;
  height?: number;
  /** Grid size in pixels (default 100) and distance/units per square. */
  grid?: { size?: number; distance?: number; units?: string };
  padding?: number;
  /** Scene darkness 0-1. */
  darkness?: number;
  tokens?: Array<{
    actorName?: string;
    actorId?: string;
    x: number;
    y: number;
    hidden?: boolean;
    disposition?: number;
  }>;
  lights?: Array<{ x: number; y: number; dim?: number; bright?: number; color?: string }>;
  walls?: Array<{ c: [number, number, number, number]; door?: boolean }>;
  activate?: boolean;
  folder?: string;
}

export class SceneBuilder {
  async build(spec: SceneSpec): Promise<any> {
    const check = permissionManager.checkWritePermission('document.create');
    if (!check.allowed) throw new Error(check.reason || 'Scene creation denied');
    if (!spec?.name) throw new Error('Scene spec requires a name');

    const groupId = `scene-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const notes: string[] = [];
    const unresolved: Array<Record<string, string>> = [];

    const sceneData: Record<string, unknown> = {
      name: spec.name,
      width: spec.width ?? 4000,
      height: spec.height ?? 3000,
      padding: spec.padding ?? 0.1,
      grid: {
        size: spec.grid?.size ?? 100,
        distance: spec.grid?.distance ?? 5,
        units: spec.grid?.units ?? 'ft',
      },
      ...(spec.background ? { background: { src: spec.background } } : {}),
      ...(typeof spec.darkness === 'number'
        ? { environment: { darknessLevel: spec.darkness } }
        : {}),
    };

    if (spec.folder) {
      const folders = (game as any).folders?.filter((f: any) => f.type === 'Scene') || [];
      const folder = folders.find(
        (f: any) => f.id === spec.folder || f.name.toLowerCase() === spec.folder!.toLowerCase()
      );
      if (folder) sceneData.folder = folder.id;
      else
        unresolved.push({
          kind: 'folder',
          name: spec.folder,
          note: 'No Scene folder with this name',
        });
    }

    const scene = await (Scene as any).create(sceneData);

    // Lights
    if (spec.lights?.length) {
      const lights = spec.lights.map(light => ({
        x: light.x,
        y: light.y,
        config: {
          dim: light.dim ?? 40,
          bright: light.bright ?? 20,
          ...(light.color ? { color: light.color } : {}),
        },
      }));
      await scene.createEmbeddedDocuments('AmbientLight', lights);
      notes.push(`Placed ${lights.length} light(s)`);
    }

    // Walls
    if (spec.walls?.length) {
      const walls = spec.walls.map(wall => ({
        c: wall.c,
        ...(wall.door ? { door: 1 } : {}),
      }));
      await scene.createEmbeddedDocuments('Wall', walls);
      notes.push(`Placed ${walls.length} wall segment(s)`);
    }

    // Tokens from actors
    const placedTokens: Array<Record<string, unknown>> = [];
    for (const tokenSpec of spec.tokens || []) {
      try {
        if (!tokenSpec.actorId && !tokenSpec.actorName) {
          throw new Error('Token spec requires actorId or actorName');
        }
        const actor = tokenSpec.actorId
          ? await documentService.resolveDocument({ documentType: 'Actor', id: tokenSpec.actorId })
          : await documentService.resolveDocument({
              documentType: 'Actor',
              name: tokenSpec.actorName!,
            });
        const tokenDoc = await actor.getTokenDocument({
          x: tokenSpec.x,
          y: tokenSpec.y,
          hidden: tokenSpec.hidden ?? false,
          ...(typeof tokenSpec.disposition === 'number'
            ? { disposition: tokenSpec.disposition }
            : {}),
        });
        const created = await scene.createEmbeddedDocuments('Token', [tokenDoc.toObject()]);
        const token = Array.isArray(created) ? created[0] : created;
        placedTokens.push({ id: token?.id, name: actor.name, x: tokenSpec.x, y: tokenSpec.y });
      } catch (error) {
        unresolved.push({
          kind: 'token',
          name: tokenSpec.actorName || tokenSpec.actorId || '?',
          note: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (placedTokens.length) notes.push(`Placed ${placedTokens.length} token(s)`);

    if (spec.activate) {
      await scene.activate();
      notes.push('Scene activated');
    }

    const result = {
      success: true,
      scene: { uuid: scene.uuid, id: scene.id, name: scene.name },
      tokens: placedTokens,
      notes,
      unresolved,
      groupId,
    };

    await auditService.record({
      operation: 'scene.build',
      toolName: 'build-scene-from-spec',
      documentRefs: [{ uuid: scene.uuid, id: scene.id, documentName: 'Scene', name: scene.name }],
      payloadSummary: {
        name: spec.name,
        tokens: spec.tokens?.length || 0,
        lights: spec.lights?.length || 0,
        walls: spec.walls?.length || 0,
      },
      resultSummary: { tokens: placedTokens.length, unresolved: unresolved.length },
      success: true,
      groupId,
      inverse: { kind: 'delete', documentType: 'Scene', ref: { uuid: scene.uuid } },
    });

    return result;
  }
}

export const sceneBuilder = new SceneBuilder();
