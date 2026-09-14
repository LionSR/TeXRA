import { z } from 'zod';

import { DisplaySessionEventSchema, RunIdSchema } from '@shared/schemas';

/**
 * One finished run as a static viewer replays it: the run aggregate's own
 * display events in commit order, the same rows the live plane delivers to a
 * subscriber. Nothing is projected on the way out and nothing is
 * reconstructed on the way in.
 *
 * The export authors four facts rather than copying them (`assembleTrace`):
 * no owner, no parent, no checkpoint and no follow-up support, because an
 * exported file has no producer, no siblings and no writable host.
 */
export const TraceDocumentSchema = z.object({
  runId: RunIdSchema,
  events: z.array(DisplaySessionEventSchema),
});

export type TraceDocument = Readonly<z.infer<typeof TraceDocumentSchema>>;
