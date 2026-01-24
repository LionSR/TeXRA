// Third-party imports
import { z } from 'zod';

// Local imports - shared schemas
import { MESSAGE_TYPES, MessageTypeSchema } from '@shared/schemas';

// Local imports - config
import { getConfig } from '@utils/config';

// ============================================================================
// Filter Schemas
// ============================================================================

export const FilterOptionsSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  messageType: MessageTypeSchema,
});
export type FilterOptions = z.infer<typeof FilterOptionsSchema>;

export const FilterResultSchema = z.object({
  shouldEmit: z.boolean(),
  debugMode: z.boolean(),
});
export type FilterResult = z.infer<typeof FilterResultSchema>;

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
