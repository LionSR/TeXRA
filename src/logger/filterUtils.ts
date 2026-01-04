// Local imports
import { MESSAGE_TYPES, type MessageType } from './messageTypes';
import { getConfig } from '@utils/config';

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
 * Get the current debug mode setting.
 * Single source of truth for debug mode configuration.
 */
export function getDebugMode(): boolean {
  return getConfig<boolean>('texra.logger.debugMode', false);
}

/**
 * Determines whether a log message should be emitted to the progress view
 * and returns the debug mode state for setting the verbose flag.
 *
 * This filtering logic is shared between:
 * - VSCodeTransport.emitLogEvent() (winston transport path)
 * - AgentLogger.createStream() (stream-based logging path)
 *
 * @param options - The log level and message type to filter
 * @returns Object with shouldEmit boolean and debugMode state
 */
export function getEmitFilter(options: FilterOptions): FilterResult {
  const debugMode = getDebugMode();

  // Always filter INTERNAL messages from progress view
  // (these are implementation details, not user-facing content)
  if (options.messageType === MESSAGE_TYPES.INTERNAL) {
    return { shouldEmit: false, debugMode };
  }

  // Filter debug-level messages when not in debug mode
  if (options.level === 'debug' && !debugMode) {
    return { shouldEmit: false, debugMode };
  }

  return { shouldEmit: true, debugMode };
}

/**
 * Determines whether a log message should be emitted to the progress view
 * based on debug mode settings and message type.
 *
 * @param options - The log level and message type to filter
 * @returns true if the message should be emitted to the progress view, false otherwise
 */
export function shouldEmitToProgressView(options: FilterOptions): boolean {
  return getEmitFilter(options).shouldEmit;
}
