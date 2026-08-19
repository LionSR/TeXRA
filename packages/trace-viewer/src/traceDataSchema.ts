/**
 * Runtime validation for trace data loaded from `trace.json` or
 * `window.__TEXRA_TRACE__`. The shared document schema owns the format,
 * including snapshot-version handling: a missing `schemaVersion` is a legacy
 * omission, a future one is rejected rather than normalized.
 */
import { z } from 'zod';

import { TraceStreamLogEntrySchema } from '@shared/schemas';
import { TraceDocumentSchema } from '@transcript/traceDocumentSchema';

export const TraceDataSchema = TraceDocumentSchema.extend({
  entries: z.array(TraceStreamLogEntrySchema),
});

export type TraceData = z.infer<typeof TraceDataSchema>;

/** Parse an exported trace before replaying it through the trusted UI path. */
export function parseTraceData(raw: unknown): TraceData {
  const result = TraceDataSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      'Trace data does not match the expected schema — this trace file may ' +
        'have been exported by an incompatible TeXRA version:\n' +
        z.prettifyError(result.error),
    );
  }
  return result.data;
}
