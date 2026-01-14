// Local imports
import { getConfig } from '@utils/config';
import { MESSAGE_TYPES, type MessageType } from './messageTypes';

export interface FilterOptions {
  level: 'debug' | 'info' | 'warn' | 'error';
  messageType: MessageType;
}

export interface FilterResult {
  /** Whether the message should be emitted to the progress view */
  shouldEmit: boolean;
  /** Current debug mode state (for setting verbose flag on emitted messages) */
  debugMode: boolean;
}

/**
 * Determines whether a log message should be emitted to the progress view
 * and returns the debug mode state for setting the verbose flag.
 *
 * This filtering logic is shared between:
 * - VSCodeTransport.emitLogEvent() (winston transport path)
 * - AgentLogger.createStream() (stream-based logging path)
 */
export function getEmitFilter(options: FilterOptions): FilterResult {
  const debugMode = getConfig<boolean>('texra.logger.debugMode', false);
  // Filter: INTERNAL messages always hidden; debug-level messages hidden unless debugMode
  const shouldEmit =
    options.messageType !== MESSAGE_TYPES.INTERNAL &&
    (options.level !== 'debug' || debugMode);
  return { shouldEmit, debugMode };
}
