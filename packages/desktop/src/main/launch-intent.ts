export interface DesktopLaunchIntent {
  show: boolean;
  shutdownForUpdate: boolean;
}

export function parseLaunchIntent(argv: readonly string[]): DesktopLaunchIntent {
  const shutdownForUpdate = argv.includes('--shutdown-for-update');
  const hidden = argv.includes('--background') || argv.includes('--hidden');
  return {
    show: !hidden && !shutdownForUpdate,
    shutdownForUpdate,
  };
}
