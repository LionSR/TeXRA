/** Persisted update notification state, isolated by host and configured storage root. */
import { z } from 'zod';

const UpdateCheckHostSchema = z.enum(['cli', 'desktop']);
export type UpdateCheckHost = z.infer<typeof UpdateCheckHostSchema>;
export const UpdateCheckRecordSchema = z.object({
  lastCheckedAt: z.int().nonnegative().nullable(),
  lastNotifiedVersion: z.string().min(1).nullable(),
});
export type UpdateCheckRecord = z.infer<typeof UpdateCheckRecordSchema>;
const UpdateCheckChangeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('checked'), at: z.int().nonnegative() }),
  z.object({ type: z.literal('notified'), version: z.string().min(1) }),
]);
export type UpdateCheckChange = z.infer<typeof UpdateCheckChangeSchema>;
