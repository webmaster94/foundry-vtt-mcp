import { describe, expect, it } from 'vitest';
import { parseLaunchIntent } from '../src/main/launch-intent.js';

describe('desktop launch intent', () => {
  it('opens normally and supports background launches', () => {
    expect(parseLaunchIntent(['bridge.exe'])).toEqual({ show: true, shutdownForUpdate: false });
    expect(parseLaunchIntent(['bridge.exe', '--background'])).toEqual({
      show: false,
      shutdownForUpdate: false,
    });
  });

  it('never shows or starts normal UI work for an update-shutdown launch', () => {
    expect(parseLaunchIntent(['bridge.exe', '--shutdown-for-update'])).toEqual({
      show: false,
      shutdownForUpdate: true,
    });
  });
});
