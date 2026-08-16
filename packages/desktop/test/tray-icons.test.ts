import path from 'node:path';
import type { AddRepresentationOptions, NativeImage } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  createMultiRepresentationTrayIcon,
  TRAY_ICON_SIZES,
  trayIconFileName,
} from '../src/main/tray-icons.js';

describe('multi-representation tray icons', () => {
  it('loads every physical size at its matching 16-DIP scale factor', () => {
    const representations: AddRepresentationOptions[] = [];
    const image = {
      addRepresentation: vi.fn((options: AddRepresentationOptions) => {
        representations.push(options);
      }),
      getScaleFactors: vi.fn(() =>
        representations.map(representation => representation.scaleFactor ?? 1)
      ),
    } as unknown as NativeImage;
    const readAsset = vi.fn((file: string) => Buffer.from(path.basename(file)));

    const result = createMultiRepresentationTrayIcon(
      'C:\\assets',
      'connected',
      { createEmpty: () => image },
      readAsset
    );

    expect(result).toBe(image);
    expect(readAsset.mock.calls.map(([file]) => path.basename(file))).toEqual(
      TRAY_ICON_SIZES.map(size => trayIconFileName('connected', size))
    );
    expect(representations.map(representation => representation.scaleFactor)).toEqual([
      1, 1.25, 1.5, 2, 2.5, 3,
    ]);
    expect(representations).toHaveLength(TRAY_ICON_SIZES.length);
    for (const representation of representations) {
      expect(representation.dataURL).toMatch(/^data:image\/png;base64,/);
    }
  });

  it('keeps state-specific asset names separate', () => {
    expect(trayIconFileName('connected', 48)).toBe('tray-icon-connected-48.png');
    expect(trayIconFileName('waiting', 48)).toBe('tray-icon-waiting-48.png');
    expect(trayIconFileName('error', 48)).toBe('tray-icon-error-48.png');
  });

  it('refuses to return an image when Electron drops a representation', () => {
    const image = {
      addRepresentation: vi.fn(),
      getScaleFactors: vi.fn(() => [1, 2, 3]),
    } as unknown as NativeImage;

    expect(() =>
      createMultiRepresentationTrayIcon('C:\\assets', 'waiting', { createEmpty: () => image }, () =>
        Buffer.from('png')
      )
    ).toThrow('missing its 1.25x image representation');
  });
});
