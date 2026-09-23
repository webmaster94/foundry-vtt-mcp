import { describe, expect, it } from 'vitest';
import { BridgeError, createToolErrorResult } from '../bridge-errors.js';
import { Logger } from '../logger.js';
import { ErrorHandler } from './error-handler.js';

describe('ErrorHandler bridge recovery contract', () => {
  it('preserves an unknown write outcome through tool error formatting', () => {
    const handler = new ErrorHandler(new Logger({ level: 'error', enableConsole: false }));
    const original = new BridgeError('UNKNOWN_OUTCOME', 'Inspect current state before retrying.');
    let caught: unknown;
    try {
      handler.handleToolError(original, 'create-actor-from-compendium', 'actor creation');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
    expect(caught).toMatchObject({ code: 'UNKNOWN_OUTCOME' });
    const result = createToolErrorResult(caught);
    expect(result).toMatchObject({ isError: true, errorCode: 'UNKNOWN_OUTCOME' });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      errorCode: 'UNKNOWN_OUTCOME',
      recovery: { action: 'inspect_state', automaticRetry: false },
    });
  });
  it.each(['NOT_CONNECTED', 'NO_HANDLER', 'VERSION_MISMATCH', 'TIMEOUT', 'QUERY_FAILED'] as const)(
    'retains %s through the tool wrapper and wire content',
    code => {
      const handler = new ErrorHandler(new Logger({ level: 'error', enableConsole: false }));
      const error = new BridgeError(code, 'original detail');
      expect(() => handler.handleToolError(error, 'test')).toThrow(error);
      expect(JSON.parse(createToolErrorResult(error).content[0].text)).toMatchObject({
        errorCode: code,
        recovery: { automaticRetry: false },
      });
    }
  );
});
