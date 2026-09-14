/**
 * Runtime validation for trace data loaded from `trace.json` or
 * `window.__TEXRA_TRACE__`. `TraceDocumentSchema` owns the format: a document
 * written by an older export fails the parse loudly below rather than being
 * normalized.
 */
import { z } from 'zod';

import {
  TraceDocumentSchema,
  type TraceDocument,
} from '@transcript/traceDocumentSchema';

/** Parse an exported trace before replaying it through the trusted UI path. */
export function parseTraceData(raw: unknown): TraceDocument {
  const result = TraceDocumentSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      'Trace data does not match the expected schema — this trace file may ' +
        'have been exported by an incompatible TeXRA version:\n' +
        z.prettifyError(result.error),
    );
  }
  return result.data;
}
