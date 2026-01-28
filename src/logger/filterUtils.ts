import { MESSAGE_TYPES, type MessageType } from '@shared/schemas';
import { getConfig } from '@utils/config';

export interface FilterOptions {
  level: 'debug' | 'info' | 'warn' | 'error';
  messageType: MessageType;
}

export interface FilterResult {
  shouldEmit: boolean;
  debugMode: boolean;
}

/**
 * Determines whether a log message should be emitted to the progress view.
 * INTERNAL messages are always hidden; debug-level messages hidden unless debugMode.
 */
export function getEmitFilter(options: FilterOptions): FilterResult {
  const debugMode = getConfig<boolean>('texra.logger.debugMode', false);
  const shouldEmit =
    options.messageType !== MESSAGE_TYPES.INTERNAL &&
    (options.level !== 'debug' || debugMode);
  return { shouldEmit, debugMode };
}
