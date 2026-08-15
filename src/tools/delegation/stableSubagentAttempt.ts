// Third-party imports
import { z } from 'zod';

// Local imports - agent storage
import type { ExecutionKVStore } from '@agent/storage/ExecutionKVStore';
import { ExecutionIdSchema, type ExecutionId } from '@shared/schemas';

const STABLE_SUBAGENT_STATE_SCHEMA_VERSION = 1;
const STABLE_SUBAGENT_ATTEMPT_KV_KEY = 'stable-subagent-attempt';
const STABLE_SUBAGENT_SEQUENCE_KEY_PREFIX = 'stable-subagent-sequence-';

const StableSubagentAttemptSchema = z.strictObject({
  schemaVersion: z.literal(STABLE_SUBAGENT_STATE_SCHEMA_VERSION),
  logicalExecutionId: ExecutionIdSchema,
  parentExecutionId: ExecutionIdSchema,
  phase: z.enum(['reserved', 'launched', 'committed', 'retryable']),
});

export type StableSubagentAttempt = z.infer<typeof StableSubagentAttemptSchema>;

const StableSubagentSequenceSchema = z.strictObject({
  schemaVersion: z.literal(STABLE_SUBAGENT_STATE_SCHEMA_VERSION),
  logicalExecutionId: ExecutionIdSchema,
  parentExecutionId: ExecutionIdSchema,
  nextAttempt: z.int().nonnegative(),
});

export type StableSubagentSequence = z.infer<
  typeof StableSubagentSequenceSchema
>;

function stableSubagentSequenceKvKey(logicalExecutionId: ExecutionId): string {
  return `${STABLE_SUBAGENT_SEQUENCE_KEY_PREFIX}${logicalExecutionId}`;
}

export function isStableSubagentStateKvKey(key: string): boolean {
  return (
    key === STABLE_SUBAGENT_ATTEMPT_KV_KEY ||
    key.startsWith(STABLE_SUBAGENT_SEQUENCE_KEY_PREFIX)
  );
}

/** Read the parent-owned attempt sequence for one stable logical call. */
export async function readStableSubagentSequence(
  store: ExecutionKVStore,
  logicalExecutionId: ExecutionId,
): Promise<StableSubagentSequence | null> {
  const raw = await store.read(stableSubagentSequenceKvKey(logicalExecutionId));
  return raw === undefined ? null : StableSubagentSequenceSchema.parse(raw);
}

/** Atomically publish the number of child attempts reserved for this call. */
export async function writeStableSubagentSequence(
  store: ExecutionKVStore,
  logicalExecutionId: ExecutionId,
  parentExecutionId: ExecutionId,
  nextAttempt: number,
): Promise<void> {
  const sequence = StableSubagentSequenceSchema.parse({
    schemaVersion: STABLE_SUBAGENT_STATE_SCHEMA_VERSION,
    logicalExecutionId,
    parentExecutionId,
    nextAttempt,
  });
  await store.write(
    stableSubagentSequenceKvKey(sequence.logicalExecutionId),
    sequence,
  );
}

/** Read a stable-call marker. Malformed present state fails validation. */
export async function readStableSubagentAttempt(
  store: ExecutionKVStore,
): Promise<StableSubagentAttempt | null> {
  const raw = await store.read(STABLE_SUBAGENT_ATTEMPT_KV_KEY);
  return raw === undefined ? null : StableSubagentAttemptSchema.parse(raw);
}

/** Atomically replace the stable-call marker at a durable lifecycle edge. */
export async function writeStableSubagentAttempt(
  store: ExecutionKVStore,
  attempt: StableSubagentAttempt,
): Promise<void> {
  await store.write(
    STABLE_SUBAGENT_ATTEMPT_KV_KEY,
    StableSubagentAttemptSchema.parse(attempt),
  );
}

export function reservedStableSubagentAttempt(
  logicalExecutionId: ExecutionId,
  parentExecutionId: ExecutionId,
): StableSubagentAttempt {
  return {
    schemaVersion: STABLE_SUBAGENT_STATE_SCHEMA_VERSION,
    logicalExecutionId,
    parentExecutionId,
    phase: 'reserved',
  };
}
