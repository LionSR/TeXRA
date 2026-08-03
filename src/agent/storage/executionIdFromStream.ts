import { ZodError } from 'zod';

import { getExecutionStore } from '@agent/storage/ExecutionKVStore';
import {
  ExecutionIdSchema,
  registeredStreamId,
  type ExecutionId,
  type ExecutionMeta,
  type StreamTabId,
} from '@shared/schemas';

/** Recover the conventional execution suffix from a persisted stream id. */
function executionIdFromStream(stream: StreamTabId): ExecutionId | undefined {
  const separator = stream.lastIndexOf('#');
  const candidate = separator >= 0 ? stream.slice(separator + 1) : stream;
  const parsed = ExecutionIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Legacy ownership boundary (#9590 A2): a `#executionId` stream-name suffix is
 * a formatting hint, not authority over an execution directory. The derived id
 * is admitted only when registered execution metadata does not contradict it —
 * an execution whose birth registration names a different stream keeps its
 * directory even when an unrelated stream resembles it by suffix. Records
 * without registration provenance (pre-#9590 history, or a stream whose
 * sidecar was lost) keep the suffix-derived answer.
 *
 * `malformedMeta` states the caller's stance on a present-but-unparseable
 * record, which may well register another owner stream (the parse failure is
 * logged at warn by the store):
 * - `'reject'` — deletion admission: corruption blocks the execution
 *   directory from being admitted, instead of reading as an absent legacy
 *   record.
 * - `'admit'` — restart repair: corruption cannot disprove the suffix, so
 *   mapping here must not throw. A corrupt record surfaces downstream: an
 *   in-flight repair candidate deliberately aborts the repair pass at its
 *   own strict settlement read, before any mutation; a settled historical
 *   stream is never consulted again, so its corruption stays inert.
 *
 * Introduced 2026-08-03 (#9590 Stage 2). Retirement: #9590 Stage 3 folds this
 * boundary into the single discriminated legacy reader; the suffix arm is
 * deleted at the issue's dated retirement decision (`streamData/` has no
 * natural expiry, so a date — no earlier than the 2026-11-01 legacy cohort —
 * is the only available gate).
 */
export async function legacyExecutionIdFromStreamSuffix(
  stream: StreamTabId,
  options: { readonly malformedMeta: 'reject' | 'admit' },
): Promise<ExecutionId | undefined> {
  const derived = executionIdFromStream(stream);
  if (derived === undefined) return undefined;
  let meta: ExecutionMeta | null;
  try {
    meta = await getExecutionStore(derived).readMetaStrict();
  } catch (error) {
    // Only a validation failure means "malformed record"; a storage read
    // failure proves nothing about ownership and must propagate rather than
    // silently admit (or silently withhold) an execution directory.
    if (!(error instanceof ZodError)) throw error;
    return options.malformedMeta === 'reject' ? undefined : derived;
  }
  const registered = registeredStreamId(meta);
  return registered !== undefined && registered !== stream
    ? undefined
    : derived;
}
