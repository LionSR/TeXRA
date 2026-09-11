// Third-party imports
import { Effect, Result } from 'effect';
import { z } from 'zod';

// Local imports - agent storage
import { getRunStore, getRunRecords } from '@agent/storage';
import { runInSession } from '@agent/runtime/RunContext';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentFinalResult } from '@agent/runtime/AgentFinalResult';
import {
  RunLeaseLostError,
  runWithInactiveRunLease,
} from '@agent/storage/runLease';
import type { RunKVStore } from '@agent/storage/RunKVStore';
import { createLog } from '@logger/logUtils';
import { RunIdSchema, RUN_OUTCOME, type RunId } from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';
import { deriveRunId } from '@utils/core/idHash';

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
  logicalRunId: RunIdSchema,
  parentRunId: RunIdSchema,
  phase: z.enum(['reserved', 'launched', 'committed', 'retryable']),
});

export type StableSubagentAttempt = z.infer<typeof StableSubagentAttemptSchema>;

const StableSubagentSequenceSchema = z.strictObject({
  schemaVersion: z.literal(STABLE_SUBAGENT_STATE_SCHEMA_VERSION),
  logicalRunId: RunIdSchema,
  parentRunId: RunIdSchema,
  nextAttempt: z.int().nonnegative(),
});

type StableSubagentSequence = z.infer<typeof StableSubagentSequenceSchema>;

function stableSubagentSequenceKvKey(logicalRunId: RunId): string {
  return `${STABLE_SUBAGENT_SEQUENCE_KEY_PREFIX}${logicalRunId}`;
}

export function isStableSubagentStateKvKey(key: string): boolean {
  return (
    key === STABLE_SUBAGENT_ATTEMPT_KV_KEY ||
    key.startsWith(STABLE_SUBAGENT_SEQUENCE_KEY_PREFIX)
  );
}

/** Read the parent-owned attempt sequence for one stable logical call. */
async function readStableSubagentSequence(
  store: RunKVStore,
  logicalRunId: RunId,
): Promise<StableSubagentSequence | null> {
  const raw = await store.read(stableSubagentSequenceKvKey(logicalRunId));
  return raw === undefined ? null : StableSubagentSequenceSchema.parse(raw);
}

/** Atomically publish the number of child attempts reserved for this call. */
async function writeStableSubagentSequence(
  store: RunKVStore,
  logicalRunId: RunId,
  parentRunId: RunId,
  nextAttempt: number,
): Promise<void> {
  const sequence = StableSubagentSequenceSchema.parse({
    schemaVersion: STABLE_SUBAGENT_STATE_SCHEMA_VERSION,
    logicalRunId,
    parentRunId,
    nextAttempt,
  });
  await store.write(
    stableSubagentSequenceKvKey(sequence.logicalRunId),
    sequence,
  );
}

/** Read a stable-call marker. Malformed present state fails validation. */
async function readStableSubagentAttempt(
  store: RunKVStore,
): Promise<StableSubagentAttempt | null> {
  const raw = await store.read(STABLE_SUBAGENT_ATTEMPT_KV_KEY);
  return raw === undefined ? null : StableSubagentAttemptSchema.parse(raw);
}

/** Atomically replace the stable-call marker at a durable lifecycle edge. */
export async function writeStableSubagentAttempt(
  store: RunKVStore,
  attempt: StableSubagentAttempt,
): Promise<void> {
  await store.write(
    STABLE_SUBAGENT_ATTEMPT_KV_KEY,
    StableSubagentAttemptSchema.parse(attempt),
  );
}

/**
 * The existing physical-attempt protocol, including its recovery restrictions.
 * Reservation, reconciliation and commit operate on the same persisted keys;
 * live run and its serialization remain with the native caller.
 */
interface StableSubagentCallIdentity {
  readonly runId: RunId;
  readonly parentRunId: RunId;
  readonly signal?: AbortSignal;
}

interface StableSubagentResult {
  readonly runId: RunId;
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

function stableAttemptRunId(logicalRunId: RunId, attempt: number): RunId {
  if (attempt === 0) return logicalRunId;
  return deriveRunId({ attempt, logicalRunId });
}

function stableStorageOperation<A>(
  session: SessionHandle,
  operation: () => Promise<A>,
): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: () => runInSession(session, operation),
    catch: ensureError,
  });
}

const inspectStableAttempt = Effect.fn('inspectStableAttempt')(function* (
  options: StableSubagentCallIdentity,
  runId: RunId,
  session: SessionHandle,
): Effect.fn.Return<StableAttemptInspection, Error> {
  const store = runInSession(session, () => getRunStore(runId));
  const persisted = yield* Effect.all([
    stableStorageOperation(session, () => store.listKeys()),
    stableStorageOperation(session, () => readStableSubagentAttempt(store)),
    getRunRecords(session, runId).readResultMeta(),
    getRunRecords(session, runId).readMeta(),
  ]).pipe(
    Effect.mapError(
      (cause) =>
        new SubagentReconciliationError(
          `Failed to inspect persisted subagent ${runId}.`,
          { cause },
        ),
    ),
  );
  const [keys, attempt, resultMeta, meta] = persisted;
  if (keys.length === 0 && meta === null && resultMeta === null)
    return { kind: 'absent' };
  if (
    !attempt ||
    attempt.logicalRunId !== options.runId ||
    attempt.parentRunId !== options.parentRunId
  ) {
    return yield* Effect.fail(
      new SubagentReconciliationError(
        `Persisted subagent ${runId} does not belong to this stable workflow call; refusing to reuse or repeat it.`,
      ),
    );
  }
  if (!resultMeta) {
    if (attempt.phase === 'committed') {
      return yield* Effect.fail(
        new SubagentReconciliationError(
          `Committed subagent ${runId} is missing its result manifest; refusing to repeat it.`,
        ),
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
    const [turnState, meta] = yield* Effect.all([
      stableStorageOperation(session, () => store.readTurnState()),
      getRunRecords(session, runId).readMeta(),
    ]).pipe(
      Effect.mapError(
        (cause) =>
          new SubagentReconciliationError(
            `Failed to inspect persisted subagent ${runId}.`,
            { cause },
          ),
      ),
    );
    const settledEvidence =
      turnState?.lastCompletedTurn !== undefined ||
      meta?.outcome === RUN_OUTCOME.COMPLETED;
    if (!settledEvidence) {
      const repair = yield* stableStorageOperation(session, () =>
        runWithInactiveRunLease(runId, () =>
          writeStableSubagentAttempt(store, { ...attempt, phase: 'retryable' }),
        ),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new SubagentReconciliationError(
              `Failed to repair the unsettled launched subagent ${runId}.`,
              { cause },
            ),
        ),
      );
      if (repair.status === 'performed') return { kind: 'advance' };
      return yield* Effect.fail(
        new SubagentReconciliationError(
          `Subagent ${runId} is still running under a live lease; refusing to repeat it.`,
        ),
      );
    }
    return yield* Effect.fail(
      new SubagentReconciliationError(
        `Cannot reconcile incomplete persisted subagent ${runId}; refusing to repeat it.`,
      ),
    );
  }
  if (attempt.phase === 'reserved') {
    return yield* Effect.fail(
      new SubagentReconciliationError(
        `Persisted subagent ${runId} has a result without a launch marker; refusing to reuse it.`,
      ),
    );
  }
  if (resultMeta.producer !== 'subagent') {
    return yield* Effect.fail(
      new SubagentReconciliationError(
        `Persisted subagent ${runId} does not match this workflow call; refusing to reuse or repeat it.`,
      ),
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
    return yield* Effect.fail(
      new SubagentReconciliationError(
        `Cannot attest durable completion for persisted subagent ${runId}; refusing to recover its result.`,
      ),
    );
  }
  yield* Effect.try({
    try: () => options.signal?.throwIfAborted(),
    catch: ensureError,
  });
  return {
    kind: 'recovered',
    result: { runId, result: resultMeta.result },
  };
});

export const throwRetryableDurabilityError = Effect.fn(
  'throwRetryableDurabilityError',
)(function* (
  runId: RunId,
  stableAttempt: StableSubagentAttempt | undefined,
  error: SubagentDurabilityError,
  session: SessionHandle,
): Effect.fn.Return<never, Error> {
  if (!stableAttempt) return yield* Effect.fail(error);
  const marker = { ...stableAttempt, phase: 'retryable' as const };
  const written = yield* stableStorageOperation(session, () =>
    writeStableSubagentAttempt(getRunStore(runId), marker),
  ).pipe(Effect.result);
  if (Result.isFailure(written)) {
    const cause = written.failure;
    if (cause instanceof RunLeaseLostError) {
      const repair = yield* stableStorageOperation(session, () =>
        runWithInactiveRunLease(runId, () =>
          writeStableSubagentAttempt(getRunStore(runId), marker),
        ),
      ).pipe(
        Effect.catch((repairError) =>
          Effect.sync(() => {
            log.warn('Retryable-marker repair write failed', {
              data: { runId, error: repairError },
            });
            return undefined;
          }),
        ),
      );
      if (repair?.status !== 'performed')
        log.warn(
          'Deferred retryable marker to resume-time reconciliation: the child lease is still held',
          { data: { runId } },
        );
      return yield* Effect.fail(error);
    }
    return yield* Effect.fail(
      new SubagentDurabilityError(
        `${error.message} Failed to mark the stable attempt as retryable.`,
        {
          cause: new AggregateError(
            [error, cause],
            `Subagent ${runId} durability recovery also failed.`,
          ),
        },
      ),
    );
  }
  return yield* Effect.fail(error);
});

/** Reserve the next physical attempt or recover an attested completed result. */
export const reserveStableAttempt = Effect.fn('reserveStableAttempt')(
  function* (
    options: StableSubagentCallIdentity,
    session: SessionHandle,
  ): Effect.fn.Return<
    | { readonly kind: 'recovered'; readonly result: StableSubagentResult }
    | {
        readonly kind: 'reserved';
        readonly runId: RunId;
        readonly attempt: StableSubagentAttempt;
      },
    Error
  > {
    yield* Effect.try({
      try: () => options.signal?.throwIfAborted(),
      catch: ensureError,
    });
    const parentStore = runInSession(session, () =>
      getRunStore(options.parentRunId),
    );
    const sequence = yield* stableStorageOperation(session, () =>
      readStableSubagentSequence(parentStore, options.runId),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new SubagentReconciliationError(
            `Failed to inspect the attempt sequence for subagent ${options.runId}.`,
            { cause },
          ),
      ),
    );
    if (
      sequence &&
      (sequence.logicalRunId !== options.runId ||
        sequence.parentRunId !== options.parentRunId)
    )
      return yield* Effect.fail(
        new SubagentReconciliationError(
          `Persisted attempt sequence for subagent ${options.runId} has different ownership.`,
        ),
      );
    let nextAttempt = sequence?.nextAttempt ?? 0;
    if (nextAttempt > MAX_STABLE_ATTEMPTS)
      return yield* Effect.fail(
        new SubagentReconciliationError(
          `Subagent ${options.runId} has an invalid durable-attempt count.`,
        ),
      );
    let unresolved: SubagentReconciliationError | undefined;
    for (let attempt = 0; attempt < nextAttempt; attempt += 1) {
      const candidate = stableAttemptRunId(options.runId, attempt);
      const inspected = yield* inspectStableAttempt(
        options,
        candidate,
        session,
      ).pipe(Effect.result);
      if (Result.isFailure(inspected)) {
        if (!(inspected.failure instanceof SubagentReconciliationError))
          return yield* Effect.fail(inspected.failure);
        unresolved ??= inspected.failure;
        continue;
      }
      const inspection = inspected.success;
      if (inspection.kind === 'recovered') return inspection;
      if (inspection.kind === 'absent')
        unresolved ??= new SubagentReconciliationError(
          `Recorded subagent attempt ${candidate} is missing; refusing to repeat it.`,
        );
    }
    if (unresolved) return yield* Effect.fail(unresolved);
    let runId: RunId;
    let candidateInspection: StableAttemptInspection;
    while (true) {
      if (nextAttempt >= MAX_STABLE_ATTEMPTS)
        return yield* Effect.fail(
          new SubagentReconciliationError(
            `Subagent ${options.runId} exceeded the ${MAX_STABLE_ATTEMPTS} durable-attempt limit.`,
          ),
        );
      runId = stableAttemptRunId(options.runId, nextAttempt);
      candidateInspection = yield* inspectStableAttempt(
        options,
        runId,
        session,
      );
      if (candidateInspection.kind === 'recovered') return candidateInspection;
      if (candidateInspection.kind !== 'advance') break;
      nextAttempt += 1;
      yield* stableStorageOperation(session, () =>
        writeStableSubagentSequence(
          parentStore,
          options.runId,
          options.parentRunId,
          nextAttempt,
        ),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new SubagentDurabilityError(
              `Failed to advance the attempt sequence for subagent ${options.runId}.`,
              { cause },
            ),
        ),
      );
    }
    const attempt: StableSubagentAttempt = {
      schemaVersion: STABLE_SUBAGENT_STATE_SCHEMA_VERSION,
      logicalRunId: options.runId,
      parentRunId: options.parentRunId,
      phase: 'reserved',
    };
    if (candidateInspection.kind === 'absent')
      yield* stableStorageOperation(session, () =>
        writeStableSubagentAttempt(getRunStore(runId), attempt),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new SubagentDurabilityError(
              `Failed to reserve stable subagent ${runId}.`,
              { cause },
            ),
        ),
      );
    yield* stableStorageOperation(session, () =>
      writeStableSubagentSequence(
        parentStore,
        options.runId,
        options.parentRunId,
        nextAttempt + 1,
      ),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new SubagentDurabilityError(
            `Failed to publish stable subagent ${runId}.`,
            { cause },
          ),
      ),
    );
    return { kind: 'reserved', runId, attempt };
  },
);

/** Attest durable completion after the child has drained its final artifacts. */
export const commitStableSubagentAttempt = Effect.fn(
  'commitStableSubagentAttempt',
)(function* (
  store: RunKVStore,
  runId: RunId,
  stableAttempt: StableSubagentAttempt,
  session: SessionHandle,
): Effect.fn.Return<void, Error> {
  const persisted = yield* getRunRecords(session, runId)
    .readResultMeta()
    .pipe(
      Effect.mapError(
        (cause) =>
          new SubagentCommitError(
            `Failed to verify durable completion for subagent ${runId}.`,
            { cause },
          ),
      ),
    );
  if (!persisted || persisted.producer !== 'subagent')
    return yield* Effect.fail(
      new SubagentCommitError(
        `Failed to persist result for subagent ${runId}.`,
      ),
    );
  yield* stableStorageOperation(session, () =>
    writeStableSubagentAttempt(store, { ...stableAttempt, phase: 'committed' }),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new SubagentCommitError(
          `Failed to commit durable completion for subagent ${runId}.`,
          { cause },
        ),
    ),
  );
});
