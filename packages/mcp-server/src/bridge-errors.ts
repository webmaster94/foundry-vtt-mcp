export type BridgeErrorCode =
  | 'NOT_CONNECTED'
  | 'NO_HANDLER'
  | 'VERSION_MISMATCH'
  | 'TIMEOUT'
  | 'UNKNOWN_OUTCOME'
  | 'QUERY_FAILED';

export class BridgeError extends Error {
  constructor(
    public code: BridgeErrorCode,
    message: string
  ) {
    super(`[${code}] ${message}`);
    this.name = 'BridgeError';
  }
}

const recoveryByCode = {
  NOT_CONNECTED: {
    action: 'check_connection',
    message: 'Check the selected server and connected GM client before retrying.',
  },
  NO_HANDLER: {
    action: 'check_versions',
    message: 'Inspect module capabilities and update the module/server pair before retrying.',
  },
  VERSION_MISMATCH: {
    action: 'check_versions',
    message: 'Align module and server versions, reload the world, and inspect capabilities.',
  },
  TIMEOUT: {
    action: 'check_connection',
    message: 'Inspect connection status and operation state before deciding whether to retry.',
  },
  UNKNOWN_OUTCOME: {
    action: 'inspect_state',
    message:
      'The write may have completed. Read current state or the audit log before retrying; do not replay the write automatically.',
  },
  QUERY_FAILED: {
    action: 'inspect_error',
    message:
      'Inspect the error and current state. Completion and retry safety are not established.',
  },
} as const;

export function getRecovery(error: unknown) {
  const code = error instanceof BridgeError ? error.code : undefined;
  return {
    automaticRetry: false as const,
    ...(code
      ? recoveryByCode[code]
      : {
          action: 'inspect_error' as const,
          message: 'Inspect the error and current state before retrying.',
        }),
  };
}

/** Include recovery in content too: MCP clients may discard extension fields. */
export function createToolErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown error occurred';
  const errorCode = error instanceof BridgeError ? error.code : undefined;
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: message,
          ...(errorCode ? { errorCode } : {}),
          recovery: getRecovery(error),
        }),
      },
    ],
    isError: true as const,
    ...(errorCode ? { errorCode } : {}),
  };
}
