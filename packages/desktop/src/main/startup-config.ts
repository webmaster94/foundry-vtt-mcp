export interface StartupConfigStore {
  ensure(): Promise<unknown>;
}

export interface StartupConfigResult {
  ok: boolean;
  error?: string;
}

export async function initializeConfigSafely(
  configStore: StartupConfigStore
): Promise<StartupConfigResult> {
  try {
    await configStore.ensure();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
