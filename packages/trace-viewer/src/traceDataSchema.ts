/**
 * Runtime validation for trace data loaded by `main.ts`'s `loadTrace()` —
 * either fetched (`trace.json`) or inlined (`window.__TEXRA_TRACE__`).
 *
 * This is the trace-viewer's external boundary: the data was authored by
 * whatever TeXRA version produced the export (CLI, extension, or desktop),
 * and `main.ts` has no static guarantee it matches this build's expected
 * shape. Mirrors `TraceDocument` (`@transcript/traceAssembler`) field-for-
 * field, reusing the same shared schemas that already define its parts
 * (`StreamSnapshotSchema`, `StreamLogEntrySchema`, `AgentConfigSchema`,
 * `ExecutionMetaSchema`, …) rather than re-deriving them, so this schema
 * tracks the real document shape instead of drifting from it.
 */
import { z } from 'zod';

import { ExecutionMetaSchema } from '@agent/storage';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  ExecutionIdSchema,
  ExecutionStatusSchema,
  StreamLogEntrySchema,
  StreamSnapshotSchema,
  StreamTabIdSchema,
} from '@shared/schemas';
import type { TraceDocument } from '@transcript/traceAssembler';

export const TraceDataSchema = z.object({
  executionId: ExecutionIdSchema,
  streamId: StreamTabIdSchema,
  config: AgentConfigSchema,
  meta: ExecutionMetaSchema.nullable(),
  entries: z.array(StreamLogEntrySchema),
  snapshot: StreamSnapshotSchema,
  terminalStatus: ExecutionStatusSchema.nullable(),
});

export type TraceData = z.infer<typeof TraceDataSchema>;

/**
 * Compile-time check that this schema's inferred shape actually accepts what
 * `assembleTrace` produces — kept in sync with `TraceDocument` rather than a
 * hand-maintained duplicate, so a field added/renamed there surfaces here as
 * a type error instead of a silent validation gap.
 */
type _AssertTraceDataAcceptsTraceDocument = TraceDocument extends TraceData
  ? true
  : never;

/**
 * Parses raw trace data (from `fetch()` or `window.__TEXRA_TRACE__`) against
 * {@link TraceDataSchema}. Throws a descriptive error identifying the trace
 * file as malformed/incompatible rather than letting an arbitrary shape flow
 * into `replayTrace()` → `dispatchMessage()`, which assumes the shape is
 * already correct and would otherwise fail with a cryptic error deep inside
 * a handler.
 */
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
