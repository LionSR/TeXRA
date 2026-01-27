import { z } from 'zod';

import { MESSAGE_TYPES, MessageTypeSchema } from '@shared/schemas';
import { getConfig } from '@utils/config';

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

export function getEmitFilter(options: FilterOptions): FilterResult {
  const debugMode = getConfig<boolean>('texra.logger.debugMode', false);
  // Filter: INTERNAL messages always hidden; debug-level messages hidden unless debugMode
  const shouldEmit =
    options.messageType !== MESSAGE_TYPES.INTERNAL &&
    (options.level !== 'debug' || debugMode);
  return { shouldEmit, debugMode };
}
