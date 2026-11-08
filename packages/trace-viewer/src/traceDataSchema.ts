/**
 * Runtime validation for trace data loaded from `trace.json` or
 * `window.__TEXRA_TRACE__`. `TraceDocumentSchema` owns the format: a document
 * written by an older export fails the parse loudly below rather than being
 * normalized (a field this build does not declare included), and so does a plugin fact this build cannot read, by the
 * store's own rules (`readTraceFacts`): a version outside its fact kind's, or a
 * value its fact kind's schema refuses. A fact whose plugin this build lacks is
 * kept as written, marked `unavailable`, as the store reads it.
 */
import { Result, Schema } from 'effect';

import {
  readTraceFacts,
  toErrorMessage,
  TraceDocumentSchema,
  type TraceDocument,
} from '@texra-ai/harness/schemas';
import { APP_FACT_KINDS } from '@texra/shared/plugins/appFactKinds';

const INCOMPATIBLE =
  'Trace data does not match the expected schema — this trace file may ' +
  'have been exported by an incompatible TeXRA version:\n';

const APP_FACT_KIND_LIST = Object.values(APP_FACT_KINDS).flat();

/** Parse an exported trace before replaying it through the trusted UI path. */
export function parseTraceData(raw: unknown): TraceDocument {
  // A field this build does not declare is a field an earlier build wrote:
  // refused, not stripped, so the row never reads as this build's.
  const result = Schema.decodeUnknownResult(TraceDocumentSchema)(raw, {
    onExcessProperty: 'error',
  });
  if (!Result.isSuccess(result))
    throw new Error(INCOMPATIBLE + result.failure.message);
  try {
    return readTraceFacts(result.success, APP_FACT_KIND_LIST);
  } catch (error) {
    throw new Error(INCOMPATIBLE + toErrorMessage(error), { cause: error });
  }
}
