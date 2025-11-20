// Type imports
import type { MessageType } from './messageTypes';

/**
 * Modern options-based interface for logging calls.
 * Replaces positional parameters with a cleaner, more maintainable approach.
 *
 * @example
 * ```typescript
 * // Old way (messy):
 * logger.warn(CHANNEL, 'Error occurred', undefined, undefined, false, errorData);
 *
 * // New way (clean):
 * logger.warnShared(CHANNEL, 'Error occurred', { data: errorData });
 * ```
 */
export interface LogOptions {
  /** Associates log with async task group for progress view */
  groupId?: string;
  /** Categorizes message for special rendering */
  messageType?: MessageType;
  /** Structured data for debug mode display */
  data?: unknown;
}

/**
 * Extended options for logUtils unified functions (deprecated).
 * @deprecated Use separate agent/shared functions instead
 */
export interface LogUtilsOptions extends LogOptions {
  /** Whether this is an agent channel vs shared channel */
  isAgent?: boolean;
}
