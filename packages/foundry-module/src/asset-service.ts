import { MODULE_ID } from './constants.js';
import { auditService } from './audit-service.js';
import { permissionManager } from './permissions.js';

/**
 * File/asset operations via Foundry's FilePicker: browse the data tree and
 * upload small files (portraits, token art, handouts) so agents can assign
 * real images instead of guessing at paths.
 */

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB — plenty for art, protects the socket

export class AssetService {
  async browse(
    request: { source?: string; directory?: string; extensions?: string[] } = {}
  ): Promise<any> {
    const source = request.source || 'data';
    const directory = request.directory || '';
    const picker =
      (foundry as any).applications?.apps?.FilePicker?.implementation ??
      (globalThis as any).FilePicker;

    const options: Record<string, unknown> = {};
    if (request.extensions?.length) options.extensions = request.extensions;

    const result = await picker.browse(source, directory, options);
    return {
      source,
      directory: result.target ?? directory,
      dirs: result.dirs || [],
      files: result.files || [],
    };
  }

  async upload(request: {
    filename: string;
    base64: string;
    directory?: string;
    mimeType?: string;
  }): Promise<any> {
    const check = permissionManager.checkWritePermission('asset.upload');
    if (!check.allowed) throw new Error(check.reason || 'Asset upload denied');

    if (!request.filename || !/^[\w.\- ]+$/.test(request.filename)) {
      throw new Error('filename must be a plain name (letters, numbers, dot, dash, underscore)');
    }

    const binary = atob(request.base64.replace(/^data:[^,]+,/, ''));
    if (binary.length > MAX_UPLOAD_BYTES) {
      throw new Error(
        `Upload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit (${Math.round(binary.length / 1024)}KB)`
      );
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const directory = request.directory || `worlds/${(game as any).world.id}/mcp-assets`;
    const picker =
      (foundry as any).applications?.apps?.FilePicker?.implementation ??
      (globalThis as any).FilePicker;

    // Ensure the target directory exists (createDirectory throws if it does — ignore)
    try {
      await picker.createDirectory('data', directory);
    } catch {
      // already exists
    }

    const file = new File([bytes], request.filename, {
      type: request.mimeType || this.guessMime(request.filename),
    });
    const result = await picker.upload('data', directory, file, {});
    const path = (result as any)?.path || `${directory}/${request.filename}`;

    await auditService.record({
      operation: 'asset.upload',
      toolName: 'upload-asset',
      payloadSummary: { path, bytes: binary.length },
      success: true,
    });

    console.log(`[${MODULE_ID}] Uploaded asset: ${path}`);
    return { success: true, path, bytes: binary.length };
  }

  private guessMime(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    const map: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      webm: 'video/webm',
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      json: 'application/json',
    };
    return map[ext || ''] || 'application/octet-stream';
  }
}

export const assetService = new AssetService();
