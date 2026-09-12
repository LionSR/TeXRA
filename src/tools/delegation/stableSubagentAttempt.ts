// Third-party imports
import { Effect, Result } from 'effect';

// Local imports - agent storage
import { getRunRecords } from '@agent/storage';
import { readChildTurnState } from '@agent/storage/runRecords';
import { runInSession } from '@agent/runtime/RunContext';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { runWithInactiveRunLease } from '@agent/storage/runLease';
import {
  aggregateId,
  RUN_OUTCOME,
  type RunEnd,
  type RunId,
  type StableSubagentPhase,
} from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';
import { deriveRunId } from '@utils/core/idHash';

/**
 * The stable-call marker for one physical attempt (#10663): the parent-owned
 * `run.subagentAttempt` row on the launching run's aggregate, keyed by the
 * attempt's run. A present but unknown phase fails closed at the row schema:
 * no defaults, no coercion.
 */
export interface StableSubagentAttempt {
  readonly runId: RunId;
  readonly logicalRunId: RunId;
  readonly parentRunId: RunId;
  readonly phase: StableSubagentPhase;
}

/** The parent's stable-subagent facts, folded latest per key from its rows. */
interface StableSubagentMarkers {
  /** Physical attempts reserved so far, by logical call. */
  readonly nextAttempt: ReadonlyMap<RunId, number>;
  /** Each attempt's latest phase, by the attempt's run. */
  readonly attempts: ReadonlyMap<RunId, StableSubagentAttempt>;
}

const readStableSubagentMarkers = (
  session: SessionHandle,
  parentRunId: RunId,
): Effect.Effect<StableSubagentMarkers, Error> =>
  session.readAggregate(aggregateId('run', parentRunId)).pipe(
    Effect.map((rows) => {
      const nextAttempt = new Map<RunId, number>();
      const attempts = new Map<RunId, StableSubagentAttempt>();
      for (const row of rows) {
        if (row.type === 'run.subagentSequence') {
          nextAttempt.set(row.logicalRunId, row.nextAttempt);
        } else if (row.type === 'run.subagentAttempt') {
          attempts.set(row.runId, {
            runId: row.runId,
            logicalRunId: row.logicalRunId,
            parentRunId,
            phase: row.phase,
          });
        }
      }
      return { nextAttempt, attempts };
    }),
  );

/** Publish the number of child attempts reserved for this call. */
const writeStableSubagentSequence = (
  session: SessionHandle,
  parentRunId: RunId,
  logicalRunId: RunId,
  nextAttempt: number,
): Effect.Effect<void, Error> =>
  session
    .commit([
      {
        type: 'run.subagentSequence',
        aggregateId: aggregateId('run', parentRunId),
        logicalRunId,
        nextAttempt,
      },
    ])
    .pipe(Effect.asVoid);

/** Replace the stable-call marker at a durable lifecycle edge. */
export const writeStableSubagentAttempt = (
  session: SessionHandle,
  attempt: StableSubagentAttempt,
): Effect.Effect<void, Error> =>
  session
    .commit([
      {
        type: 'run.subagentAttempt',
        aggregateId: aggregateId('run', attempt.parentRunId),
        runId: attempt.runId,
        logicalRunId: attempt.logicalRunId,
        phase: attempt.phase,
      },
    ])
    .pipe(Effect.asVoid);

/**
 * The existing physical-attempt protocol, including its recovery restrictions.
 * Reservation, reconciliation and commit operate on the same parent-owned
 * rows; live run and its serialization remain with the native caller.
 */
interface StableSubagentCallIdentity {
  readonly runId: RunId;
  readonly parentRunId: RunId;
  readonly signal?: AbortSignal;
}

interface StableSubagentResult {
  readonly runId: RunId;
  readonly result: RunEnd;
}

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

const inspectStableAttempt = Effect.fn('inspectStableAttempt')(function* (
  options: StableSubagentCallIdentity,
  runId: RunId,
  attempt: StableSubagentAttempt | null,
  session: SessionHandle,
): Effect.fn.Return<StableAttemptInspection, Error> {
  const persisted = yield* Effect.all([
    getRunRecords(session, runId).readResultMeta(),
    getRunRecords(session, runId).exists(),
    getRunRecords(session, runId).readRunEnd(),
  ]).pipe(
    Effect.mapError(
      (cause) =>
        new SubagentReconciliationError(
          `Failed to inspect persisted subagent ${runId}.`,
          { cause },
        ),
    ),
  );
  const [resultMeta, exists, runEnd] = persisted;
  if (attempt === null && !exists && resultMeta === null)
    return { kind: 'absent' };
  // The marker was read from this call's parent aggregate, so a parent
  // mismatch is already impossible; only the logical call can disagree.
  if (attempt === null || attempt.logicalRunId !== options.runId) {
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
    // a settled child turn or a persisted COMPLETED outcome proves the
    // settle path ran, so those stay irreconcilable. Otherwise the child
    // never reached terminal persistence (interrupted, or its artifact drain
    // failed and the parent's failure-time retryable write was refused);
    // repair the marker here, under the inactive-lease fence so a live
    // child's still-held lease keeps refusing the write.
    const turns = yield* readChildTurnState(session, runId).pipe(
      Effect.mapError(
        (cause) =>
          new SubagentReconciliationError(
            `Failed to inspect persisted subagent ${runId}.`,
            { cause },
          ),
      ),
    );
    const settledEvidence =
      turns.lastCompleted !== null || runEnd?.outcome === RUN_OUTCOME.COMPLETED;
    if (!settledEvidence) {
      const retryable: StableSubagentAttempt = {
        ...attempt,
        phase: 'retryable',
      };
      const repair = yield* Effect.tryPromise({
        try: () =>
          runInSession(session, () =>
            runWithInactiveRunLease(runId, async () => {
              // The session's ordered publisher, awaited to durability
              // inside the fence, as the checkpoint journal is.
              session.publish([
                {
                  type: 'run.subagentAttempt',
                  aggregateId: aggregateId('run', retryable.parentRunId),
                  runId: retryable.runId,
                  logicalRunId: retryable.logicalRunId,
                  phase: retryable.phase,
                },
              ]);
              await session.settlePublications();
            }),
          ),
        catch: (cause) =>
          new SubagentReconciliationError(
            `Failed to repair the unsettled launched subagent ${runId}.`,
            { cause },
          ),
      });
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
  // How the attempt ended is the `run.end` row's fact; the manifest carries
  // only its output.
  if (runEnd?.outcome !== RUN_OUTCOME.COMPLETED) return { kind: 'advance' };
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
    result: { runId, result: { ...runEnd, output: resultMeta.output } },
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
  const written = yield* writeStableSubagentAttempt(session, {
    ...stableAttempt,
    phase: 'retryable',
  }).pipe(Effect.result);
  if (Result.isFailure(written)) {
    return yield* Effect.fail(
      new SubagentDurabilityError(
        `${error.message} Failed to mark the stable attempt as retryable.`,
        {
          cause: new AggregateError(
            [error, written.failure],
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
    const markers = yield* readStableSubagentMarkers(
      session,
      options.parentRunId,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new SubagentReconciliationError(
            `Failed to inspect the attempt sequence for subagent ${options.runId}.`,
            { cause },
          ),
      ),
    );
    const markerOf = (runId: RunId): StableSubagentAttempt | null =>
      markers.attempts.get(runId) ?? null;
    let nextAttempt = markers.nextAttempt.get(options.runId) ?? 0;
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
        markerOf(candidate),
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
        markerOf(runId),
        session,
      );
      if (candidateInspection.kind === 'recovered') return candidateInspection;
      if (candidateInspection.kind !== 'advance') break;
      nextAttempt += 1;
      yield* writeStableSubagentSequence(
        session,
        options.parentRunId,
        options.runId,
        nextAttempt,
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
      runId,
      logicalRunId: options.runId,
      parentRunId: options.parentRunId,
      phase: 'reserved',
    };
    if (candidateInspection.kind === 'absent')
      yield* writeStableSubagentAttempt(session, attempt).pipe(
        Effect.mapError(
          (cause) =>
            new SubagentDurabilityError(
              `Failed to reserve stable subagent ${runId}.`,
              { cause },
            ),
        ),
      );
    yield* writeStableSubagentSequence(
      session,
      options.parentRunId,
      options.runId,
      nextAttempt + 1,
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
  yield* writeStableSubagentAttempt(session, {
    ...stableAttempt,
    phase: 'committed',
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SubagentCommitError(
          `Failed to commit durable completion for subagent ${runId}.`,
          { cause },
        ),
    ),
  );
});
