/**
 * Runtime validation for trace data loaded from `trace.json` or
 * `window.__TEXRA_TRACE__`. `TraceDocumentSchema` owns the format: a document
 * written by an older export fails the parse loudly below rather than being
 * normalized, and so does a plugin fact this build cannot read, by the
 * store's own rules (`readTraceFacts`): a version outside its arm's, or a
 * value its arm's schema refuses. A fact whose plugin this build lacks is
 * left out, as the store leaves it out.
 */
import { z } from 'zod';

import {
  readTraceFacts,
  TraceDocumentSchema,
  type TraceDocument,
} from '@texra-ai/harness/schemas';
import { APP_PLUGIN_ARMS } from '@texra/shared/plugins/appArms';

const INCOMPATIBLE =
  'Trace data does not match the expected schema — this trace file may ' +
  'have been exported by an incompatible TeXRA version:\n';

const APP_ARMS = Object.values(APP_PLUGIN_ARMS).flat();

/** Parse an exported trace before replaying it through the trusted UI path. */
export function parseTraceData(raw: unknown): TraceDocument {
  const result = TraceDocumentSchema.safeParse(raw);
  if (!result.success)
    throw new Error(INCOMPATIBLE + z.prettifyError(result.error));
  try {
    return readTraceFacts(result.data, APP_ARMS);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(INCOMPATIBLE + reason, { cause: error });
  }
}
