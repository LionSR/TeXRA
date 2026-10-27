import { Schema, Struct } from 'effect';

import type { AttachedMemoryMiss, RunId, RunOutcome } from '@shared/schemas';
import {
  AttachedMemoryMissSchema,
  emptyRunEndOutput,
  RetryErrorInfoSchema,
  RunEndSchema,
  RunIdSchema,
} from '@shared/schemas';

/**
 * A run's report to its lifecycle: the `run.end` payload while it is still
 * an in-memory hand-off, plus the run it belongs to and the attached-memory
 * misses the delivery reports. `error` is the run's own provider/runtime
 * error, not yet classified; `runWithLifecycle` classifies it into the
 * `run.end` row's error, and the result it returns for a failed child carries
 * the normalized error the child's delivery reports.
 */
const RunEndResultSchema = RunEndSchema.mapFields(
  Struct.omit(['error']),
).mapFields(
  Struct.assign({
    runId: RunIdSchema,
    memoryMisses: Schema.optional(Schema.Array(AttachedMemoryMissSchema)),
    error: Schema.optional(RetryErrorInfoSchema),
  }),
);

/** A run's report to its lifecycle (see `RunEndResultSchema` above). */
export type RunEndResult = typeof RunEndResultSchema.Type;

/** The report of a run that ended before its loop produced an output. */
export function buildTerminalRunEndResult(
  outcome: RunOutcome,
  runId: RunId,
  memoryMisses?: AttachedMemoryMiss[],
): RunEndResult {
  return {
    outcome,
    output: emptyRunEndOutput(),
    runId,
    ...(memoryMisses?.length ? { memoryMisses } : {}),
  };
}
