import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FoundryDataAccess } from './data-access.js';
import { auditService } from './audit-service.js';
import { permissionManager } from './permissions.js';

describe('FoundryDataAccess scene navigation', () => {
  const previousScene = {
    id: 'old-scene',
    uuid: 'Scene.old-scene',
    name: 'Old Scene',
    active: true,
  };
  const targetScene = {
    id: 'new-scene',
    uuid: 'Scene.new-scene',
    name: 'New Scene',
    active: false,
    dimensions: { width: 2000, height: 1000 },
    activate: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    targetScene.activate.mockClear();
    (globalThis as any).game = {
      ready: true,
      world: { id: 'test-world' },
      user: { isGM: true },
      scenes: { contents: [previousScene, targetScene] },
    };
    vi.spyOn(auditService, 'record').mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete (globalThis as any).game;
    delete (globalThis as any).canvas;
  });

  it('blocks activation when write operations are disabled', async () => {
    vi.spyOn(permissionManager, 'checkWritePermission').mockReturnValue({
      allowed: false,
      reason: 'disabled',
    });

    await expect(
      new FoundryDataAccess().switchScene({ scene_identifier: 'new-scene' })
    ).rejects.toThrow('disabled');
    expect(targetScene.activate).not.toHaveBeenCalled();
  });

  it('supports a no-write dry run', async () => {
    vi.spyOn(permissionManager, 'checkWritePermission').mockReturnValue({ allowed: true });

    const result = await new FoundryDataAccess().switchScene({
      scene_identifier: 'new-scene',
      dryRun: true,
    });

    expect(result).toMatchObject({
      success: true,
      dryRun: true,
      sceneId: 'new-scene',
      previousSceneId: 'old-scene',
    });
    expect(targetScene.activate).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('audits activation with an undoable previous-scene inverse', async () => {
    vi.spyOn(permissionManager, 'checkWritePermission').mockReturnValue({ allowed: true });

    await new FoundryDataAccess().switchScene({
      scene_identifier: 'new-scene',
      optimize_view: false,
    });

    expect(targetScene.activate).toHaveBeenCalledOnce();
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'scene.activate',
        toolName: 'switch-scene',
        success: true,
        inverse: { kind: 'activate-scene', ref: { uuid: 'Scene.old-scene' } },
      })
    );
  });

  it('keeps a committed activation successful and undoable when canvas pan fails', async () => {
    vi.spyOn(permissionManager, 'checkWritePermission').mockReturnValue({ allowed: true });
    (globalThis as any).canvas = {
      scene: targetScene,
      screenDimensions: [1200, 800],
      pan: vi.fn().mockRejectedValue(new Error('canvas unavailable')),
    };

    await expect(
      new FoundryDataAccess().switchScene({ scene_identifier: 'new-scene' })
    ).resolves.toMatchObject({
      success: true,
      sceneId: 'new-scene',
      viewWarning: expect.stringContaining('canvas unavailable'),
    });
    expect(targetScene.activate).toHaveBeenCalledOnce();
    expect(auditService.record).toHaveBeenCalledOnce();
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        inverse: { kind: 'activate-scene', ref: { uuid: 'Scene.old-scene' } },
      })
    );
  });
});
