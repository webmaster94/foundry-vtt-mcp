import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { NativeImage } from 'electron';

export const TRAY_ICON_SIZES = [16, 20, 24, 32, 40, 48] as const;
export type TrayIconState = 'connected' | 'waiting' | 'error';

export interface NativeImageFactory {
  createEmpty(): NativeImage;
}

export type TrayAssetReader = (file: string) => Buffer;

export function trayIconFileName(state: TrayIconState, size: number): string {
  return `tray-icon-${state}-${size}.png`;
}

export function createMultiRepresentationTrayIcon(
  assetsDirectory: string,
  state: TrayIconState,
  factory: NativeImageFactory,
  readAsset: TrayAssetReader = readFileSync
): NativeImage {
  const image = factory.createEmpty();
  const expectedScaleFactors = TRAY_ICON_SIZES.map(size => size / TRAY_ICON_SIZES[0]);
  for (const size of TRAY_ICON_SIZES) {
    const encodedPng = readAsset(path.join(assetsDirectory, trayIconFileName(state, size)));
    image.addRepresentation({
      scaleFactor: size / TRAY_ICON_SIZES[0],
      dataURL: `data:image/png;base64,${encodedPng.toString('base64')}`,
    });
  }
  const actualScaleFactors = image.getScaleFactors();
  const missingScaleFactor = expectedScaleFactors.find(
    expected => !actualScaleFactors.some(actual => Math.abs(actual - expected) < 0.001)
  );
  if (missingScaleFactor !== undefined) {
    throw new Error(`Tray icon is missing its ${missingScaleFactor}x image representation`);
  }
  return image;
}
