// Third-party imports
import { z } from 'zod';

// Local imports - agent storage
import { getExecutionStore, type ResultMeta } from '@agent/storage';
import type { AgentFinalResult } from '@agent/runtime/AgentFinalResult';
import {
  ExecutionLeaseLostError,
  runWithInactiveExecutionLease,
} from '@agent/storage/executionLease';
import type { ExecutionKVStore } from '@agent/storage/ExecutionKVStore';
import { createLog } from '@logger/logUtils';
import {
  ExecutionIdSchema,
  RUN_OUTCOME,
  type ExecutionId,
} from '@shared/schemas';
import { deriveExecutionId } from '@utils/core/idHash';

// Version stays 1 across the `committed` phase addition by decision (#10663):
// legacy v1 markers (reserved/launched/retryable) remain readable here, while
// pre-#10646 readers sharing this KV state reject a `committed` marker at
// parse time; downgrade or mixed-version recovery is unsupported. A present
// but unknown version or phase fails closed: no defaults, no coercion.
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

type StableSubagentSequence = z.infer<typeof StableSubagentSequenceSchema>;

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
async function readStableSubagentSequence(
  store: ExecutionKVStore,
  logicalExecutionId: ExecutionId,
): Promise<StableSubagentSequence | null> {
  const raw = await store.read(stableSubagentSequenceKvKey(logicalExecutionId));
  return raw === undefined ? null : StableSubagentSequenceSchema.parse(raw);
}

/** Atomically publish the number of child attempts reserved for this call. */
async function writeStableSubagentSequence(
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
async function readStableSubagentAttempt(
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

function reservedStableSubagentAttempt(
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

/**
 * The existing physical-attempt protocol, including its recovery restrictions.
 * Reservation, reconciliation and commit operate on the same persisted keys;
 * live execution and its serialization remain with the native caller.
 */
interface StableSubagentCallIdentity {
  readonly executionId: ExecutionId;
  readonly parentExecutionId: ExecutionId;
  readonly signal?: AbortSignal;
}

interface StableSubagentResult {
  readonly executionId: ExecutionId;
  readonly result: AgentFinalResult;
}

const log = createLog('stableSubagentAttempt');

type StableAttemptInspection =
  | { readonly kind: 'absent' }
  | { readonly kind: 'advance' }
  | {
      readonly kind: 'recovered';
      readonly result: StableSubagentResult;
    };

export class SubagentDurabilityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SubagentDurabilityError';
  }
}

class SubagentReconciliationError extends SubagentDurabilityError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SubagentReconciliationError';
  }
}

export class SubagentCommitError extends SubagentDurabilityError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SubagentCommitError';
  }
}

const MAX_STABLE_ATTEMPTS = 1_024;

function stableAttemptExecutionId(
  logicalExecutionId: ExecutionId,
  attempt: number,
): ExecutionId {
  if (attempt === 0) return logicalExecutionId;
  return deriveExecutionId({ attempt, logicalExecutionId });
}

async function inspectStableAttempt(
  options: StableSubagentCallIdentity,
  executionId: ExecutionId,
): Promise<StableAttemptInspection> {
  const store = getExecutionStore(executionId);
  let persisted: [string[], StableSubagentAttempt | null, ResultMeta | null];
  try {
    persisted = await Promise.all([
      store.listKeys(),
      readStableSubagentAttempt(store),
      store.readResultMeta(),
    ]);
  } catch (error) {
    throw new SubagentReconciliationError(
      `Failed to inspect persisted subagent ${executionId}.`,
      { cause: error },
    );
  }
  const [keys, attempt, resultMeta] = persisted;
  if (keys.length === 0) return { kind: 'absent' };
  if (
    !attempt ||
    attempt.logicalExecutionId !== options.executionId ||
    attempt.parentExecutionId !== options.parentExecutionId
  ) {
    throw new SubagentReconciliationError(
      `Persisted subagent ${executionId} does not belong to this stable workflow call; refusing to reuse or repeat it.`,
    );
  }
  if (!resultMeta) {
    if (attempt.phase === 'committed') {
      throw new SubagentReconciliationError(
        `Committed subagent ${executionId} is missing its result manifest; refusing to repeat it.`,
      );
    }
    if (attempt.phase !== 'launched') return { kind: 'advance' };
    // A launched attempt without a manifest is unsafe to repeat only if the
    // child may have finished side-effectful work whose manifest was lost:
    // a recorded completed turn or a persisted COMPLETED outcome proves the
    // settle path ran, so those stay irreconcilable. Otherwise the child
    // never reached terminal persistence (interrupted, or its artifact drain
    // failed and the parent's failure-time retryable write was refused as
    // lease-lost); repair the marker here, under the inactive-lease fence
    // so a live child's still-held lease keeps refusing the write.
    let settledEvidence: boolean;
    try {
      const [turnState, meta] = await Promise.all([
        store.readTurnState(),
        store.readMeta(),
      ]);
      settledEvidence =
        turnState?.lastCompletedTurn !== undefined ||
        meta?.outcome === RUN_OUTCOME.COMPLETED;
    } catch (error) {
      throw new SubagentReconciliationError(
        `Failed to inspect persisted subagent ${executionId}.`,
        { cause: error },
      );
    }
    if (!settledEvidence) {
      const repair = await runWithInactiveExecutionLease(executionId, () =>
        writeStableSubagentAttempt(store, {
          ...attempt,
          phase: 'retryable',
        }),
      ).catch((error: unknown) => {
        throw new SubagentReconciliationError(
          `Failed to repair the unsettled launched subagent ${executionId}.`,
          { cause: error },
        );
      });
      if (repair.status === 'performed') return { kind: 'advance' };
      throw new SubagentReconciliationError(
        `Subagent ${executionId} is still running under a live lease; refusing to repeat it.`,
      );
    }
    throw new SubagentReconciliationError(
      `Cannot reconcile incomplete persisted subagent ${executionId}; refusing to repeat it.`,
    );
  }
  if (attempt.phase === 'reserved') {
    throw new SubagentReconciliationError(
      `Persisted subagent ${executionId} has a result without a launch marker; refusing to reuse it.`,
    );
  }
  if (resultMeta.producer !== 'subagent') {
    throw new SubagentReconciliationError(
      `Persisted subagent ${executionId} does not match this workflow call; refusing to reuse or repeat it.`,
    );
  }
  if (resultMeta.parentExecutionId !== options.parentExecutionId) {
    throw new SubagentReconciliationError(
      `Persisted subagent ${executionId} has different parent lineage; refusing to reuse or repeat it.`,
    );
  }
  if (attempt.phase === 'retryable') return { kind: 'advance' };
  if (resultMeta.result.outcome !== 'completed') return { kind: 'advance' };
  if (attempt.phase !== 'committed') {
    // A completed manifest proves only that the child turn settled. Recovery
    // additionally requires the marker written after the child artifact drain
    // and before its lease record is deleted. Lease absence is not an
    // attestation: a later lease claim may already have removed an
    // abandoned lease from a failed drain. This ambiguity deliberately stays
    // irreconcilable rather than risking repeated side-effectful work.
    throw new SubagentReconciliationError(
      `Cannot attest durable completion for persisted subagent ${executionId}; refusing to recover its result.`,
    );
  }
  options.signal?.throwIfAborted();
  return {
    kind: 'recovered',
    result: { executionId, result: resultMeta.result },
  };
}

export async function throwRetryableDurabilityError(
  executionId: ExecutionId,
  stableAttempt: StableSubagentAttempt | undefined,
  error: SubagentDurabilityError,
): Promise<never> {
  if (!stableAttempt) throw error;
  const marker = { ...stableAttempt, phase: 'retryable' as const };
  try {
    await writeStableSubagentAttempt(getExecutionStore(executionId), marker);
  } catch (cause) {
    // A child whose artifact drain failed abandons its lease with the record
    // retained, so this parent-side write is refused as lease-lost until the
    // stale horizon. The refusal is not a recovery failure: reconciliation
    // repairs an unsettled launched attempt on the next resume (see
    // inspectStableAttempt), so surface the original durability error alone.
    if (cause instanceof ExecutionLeaseLostError) {
      const repair = await runWithInactiveExecutionLease(executionId, () =>
        writeStableSubagentAttempt(getExecutionStore(executionId), marker),
      ).catch((repairError: unknown) => {
        log.warn('Retryable-marker repair write failed', {
          data: { executionId, error: repairError },
        });
        return undefined;
      });
      if (repair?.status !== 'performed') {
        log.warn(
          'Deferred retryable marker to resume-time reconciliation: the child lease is still held',
          { data: { executionId } },
        );
      }
      throw error;
    }
    throw new SubagentDurabilityError(
      `${error.message} Failed to mark the stable attempt as retryable.`,
      {
        cause: new AggregateError(
          [error, cause],
          `Subagent ${executionId} durability recovery also failed.`,
        ),
      },
    );
  }
  throw error;
}

/** Reserve the next physical attempt or recover an attested completed result. */
export async function reserveStableAttempt(
  options: StableSubagentCallIdentity,
): Promise<
  | {
      readonly kind: 'recovered';
      readonly result: StableSubagentResult;
    }
  | {
      readonly kind: 'reserved';
      readonly executionId: ExecutionId;
      readonly attempt: StableSubagentAttempt;
    }
> {
  options.signal?.throwIfAborted();
  // The parent sequence enumerates every reserved child ID. Individual child
  // markers own launch state, so a deleted early directory cannot become a
  // reusable hole or hide a later completed result.
  const parentStore = getExecutionStore(options.parentExecutionId);
  let sequence: StableSubagentSequence | null;
  try {
    sequence = await readStableSubagentSequence(
      parentStore,
      options.executionId,
    );
  } catch (cause) {
    throw new SubagentReconciliationError(
      `Failed to inspect the attempt sequence for subagent ${options.executionId}.`,
      { cause },
    );
  }
  if (
    sequence &&
    (sequence.logicalExecutionId !== options.executionId ||
      sequence.parentExecutionId !== options.parentExecutionId)
  ) {
    throw new SubagentReconciliationError(
      `Persisted attempt sequence for subagent ${options.executionId} has different ownership.`,
    );
  }
  let nextAttempt = sequence?.nextAttempt ?? 0;
  if (nextAttempt > MAX_STABLE_ATTEMPTS) {
    throw new SubagentReconciliationError(
      `Subagent ${options.executionId} has an invalid durable-attempt count.`,
    );
  }

  let unresolved: SubagentReconciliationError | undefined;
  for (let attempt = 0; attempt < nextAttempt; attempt += 1) {
    const candidate = stableAttemptExecutionId(options.executionId, attempt);
    try {
      const inspection = await inspectStableAttempt(options, candidate);
      if (inspection.kind === 'recovered') return inspection;
      if (inspection.kind === 'absent') {
        unresolved ??= new SubagentReconciliationError(
          `Recorded subagent attempt ${candidate} is missing; refusing to repeat it.`,
        );
      }
    } catch (error) {
      if (!(error instanceof SubagentReconciliationError)) throw error;
      unresolved ??= error;
    }
  }
  if (unresolved) throw unresolved;

  let executionId: ExecutionId;
  let candidateInspection: StableAttemptInspection;
  while (true) {
    if (nextAttempt >= MAX_STABLE_ATTEMPTS) {
      throw new SubagentReconciliationError(
        `Subagent ${options.executionId} exceeded the ${MAX_STABLE_ATTEMPTS} durable-attempt limit.`,
      );
    }
    executionId = stableAttemptExecutionId(options.executionId, nextAttempt);
    candidateInspection = await inspectStableAttempt(options, executionId);
    if (candidateInspection.kind === 'recovered') {
      return candidateInspection;
    }
    if (candidateInspection.kind !== 'advance') break;
    nextAttempt += 1;
    try {
      await writeStableSubagentSequence(
        parentStore,
        options.executionId,
        options.parentExecutionId,
        nextAttempt,
      );
    } catch (cause) {
      throw new SubagentDurabilityError(
        `Failed to advance the attempt sequence for subagent ${options.executionId}.`,
        { cause },
      );
    }
  }
  const attempt = reservedStableSubagentAttempt(
    options.executionId,
    options.parentExecutionId,
  );
  if (candidateInspection.kind === 'absent') {
    try {
      await writeStableSubagentAttempt(getExecutionStore(executionId), attempt);
    } catch (cause) {
      throw new SubagentDurabilityError(
        `Failed to reserve stable subagent ${executionId}.`,
        { cause },
      );
    }
  }
  try {
    await writeStableSubagentSequence(
      parentStore,
      options.executionId,
      options.parentExecutionId,
      nextAttempt + 1,
    );
  } catch (cause) {
    throw new SubagentDurabilityError(
      `Failed to publish stable subagent ${executionId}.`,
      { cause },
    );
  }
  return { kind: 'reserved', executionId, attempt };
}

/** Attest durable completion after the child has drained its final artifacts. */
export async function commitStableSubagentAttempt(
  store: ExecutionKVStore,
  executionId: ExecutionId,
  stableAttempt: StableSubagentAttempt,
): Promise<void> {
  let persisted: ResultMeta | null;
  try {
    persisted = await store.readResultMeta();
  } catch (cause) {
    throw new SubagentCommitError(
      `Failed to verify durable completion for subagent ${executionId}.`,
      { cause },
    );
  }
  if (!persisted || persisted.producer !== 'subagent') {
    throw new SubagentCommitError(
      `Failed to persist result for subagent ${executionId}.`,
    );
  }
  try {
    await writeStableSubagentAttempt(store, {
      ...stableAttempt,
      phase: 'committed',
    });
  } catch (cause) {
    throw new SubagentCommitError(
      `Failed to commit durable completion for subagent ${executionId}.`,
      { cause },
    );
  }
}
