import { z } from 'zod';

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
 * the normalized error the child's delivery reports. Domain verdicts such as
 * rejected document output end FAILED without one, their diagnostics staying
 * in the output.
 */
const RunEndResultSchema = RunEndSchema.omit({ error: true }).extend({
  runId: RunIdSchema,
  memoryMisses: z.array(AttachedMemoryMissSchema).optional(),
  error: RetryErrorInfoSchema.optional(),
});

export type RunEndResult = z.infer<typeof RunEndResultSchema>;

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
