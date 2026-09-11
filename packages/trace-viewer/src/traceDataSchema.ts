/**
 * Runtime validation for trace data loaded from `trace.json` or
 * `window.__TEXRA_TRACE__`. The document is a projection of the run's
 * `RunView` plus its transcript entries, and the shared `TraceDocumentSchema`
 * owns that format: a document written by an older export fails the parse
 * loudly below rather than being normalized.
 */
import { z } from 'zod';

import { StreamLogEntrySchema } from '@shared/schemas';
import { TraceDocumentSchema } from '@transcript/traceDocumentSchema';

export const TraceDataSchema = TraceDocumentSchema.extend({
  entries: z.array(StreamLogEntrySchema),
});

type TraceData = z.infer<typeof TraceDataSchema>;

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
