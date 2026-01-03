// Local imports
import { MESSAGE_TYPES, type MessageType } from './messageTypes';
import { getConfig } from '@utils/config';

export interface FilterOptions {
  level: 'debug' | 'info' | 'warn' | 'error';
  messageType: MessageType;
}

/**
 * Determines whether a log message should be emitted to the progress view
 * based on debug mode settings and message type.
 *
 * This filtering logic is shared between:
 * - ProgressViewSink.handleLogMessage() (normal logging path)
 * - AgentLogger.createStream() (stream-based logging path)
 *
 * @param options - The log level and message type to filter
 * @returns true if the message should be emitted to the progress view, false otherwise
 */
export function shouldEmitToProgressView(options: FilterOptions): boolean {
  const debugMode = getConfig<boolean>('texra.logger.debugMode', false);

  // Filter debug-level messages when not in debug mode
  if (options.level === 'debug' && !debugMode) {
    return false;
  }

  // Always filter INTERNAL messages from progress view
  // (these are implementation details, not user-facing content)
  if (options.messageType === MESSAGE_TYPES.INTERNAL) {
    return false;
  }

  return true;
}
