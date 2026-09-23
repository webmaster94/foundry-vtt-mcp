import type { Logger } from '../logger.js';
import type { ToolObservation } from './query-timing.js';

export function createToolObserver(env: NodeJS.ProcessEnv, logger: Logger) {
  if (env.FOUNDRY_DIAGNOSTICS !== 'timing') return undefined;
  return (observation: ToolObservation): void => {
    logger.info('Game API timing', observation);
  };
}
