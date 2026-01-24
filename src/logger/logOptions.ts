// Type imports
import type { MessageType } from '@shared/schemas';

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
 * logger.warn(CHANNEL, 'Error occurred', { data: errorData });
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
 * Internal options for logUtils functions.
 * @internal - Most code should not use this directly
 */
export interface LogUtilsOptions extends LogOptions {
  /** Internal: Whether this is an agent channel vs shared channel */
  isAgent?: boolean;
}
