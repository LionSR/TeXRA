// Third-party imports
import { Cause, Effect, Exit, Stream } from 'effect';

// Local imports
import { TraceEmitter, type AgentTrace } from '@agent/trace';
import { finalizeRunTerminal } from '@agent/runtime/AgentRunLifecycle';
import type { ChildRunPause, ChildRunPort } from '@agent/runtime/childRunLoop';
import { RunHandle } from '@agent/runtime/RunHandle';
import { Runs } from '@agent/runtime/runRegistry';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { formatDelivery } from '@agent/runtime/deliveryEnvelope';
import { classifyAgentError } from '@common/errors';
import {
  aggregateId,
  aggregateTarget,
  RUN_OUTCOME,
  RUN_SUBSTATE,
} from '@shared/schemas';
import { DELIVERY_TAG } from '@shared/deliveryTags';
import { escapeText } from '@shared/utils/xmlEscape';
import type { RunId, RunIdentity } from '@shared/schemas';
import { ToolError } from '@shared/schemas';
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import { generateRunId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

interface CreateChildRunOptions {
  /** What owns this run — the launch site declares the truth once. */
  run: RunIdentity;
}

/**
 * Normalize a child task's raw label to the ≤80-char description
 * `registerRun` writes as the run's one `run.description` row (#9590 A4).
 */
export function childRunDescription(raw: string): string {
  return truncateWithEllipsis(raw, 80);
}

/**
 * Create a child run's presentation and handle for a background child task.
 * Every launch site calls this inside `startDetachedChildRunLoop`, whose
 * owned-run launch guard owns a failed launch's compensation.
 */
export const createChildRun = Effect.fn('createChildRun')(function* (
  session: SessionHandle,
  runId: RunId,
  parentRunId: RunId,
  options: CreateChildRunOptions,
): Effect.fn.Return<ChildRunPort, never, Runs> {
  // No barrier here: registration committed the launch and its activation
  // awaited (`registerRun`), and every write below is either awaited or this
  // run's own queued fact, which its own drain answers for. A session-wide
  // settle would instead report whatever session-scoped publication anyone
  // else queued and fail an otherwise sound launch over it.
  const runs = yield* Runs;
  // The run's canonical event publication, from its first event: the trace
  // is built with the session as its sink, and closed with the run.
  const trace = new TraceEmitter((event) =>
    session.trace.publish(runId, event),
  );
  const handle = new RunHandle(
    {
      runId,
      identity: options.run,
    },
    parentRunId,
    trace,
  );
  // Registration already committed the launch, its configuration and its
  // activation together. The handle is tracked by the loop (`track`) once
  // its stop target exists, so a stop never finds this handle with nothing
  // to interrupt.
  return {
    logger: trace,
    track: () => runs.track(handle),
    finalize: (finalizeOptions) =>
      finalizeChildRun({
        handle,
        session,
        logger: trace,
        closeTrace: () => trace.close(),
        options: finalizeOptions,
      }),
  } satisfies ChildRunPort;
});

interface FinalizeChildRunArgs {
  handle: RunHandle;
  session: SessionHandle;
  logger: AgentTrace;
  closeTrace: () => void;
  options: Parameters<ChildRunPort['finalize']>[0];
}

/**
 * Finalize a child run: presentation logging plus the child's report of
 * its own exit, then the shared terminal finalizer (settle, untrack, terminal
 * run phase). Child runs never traverse
 * the run lifecycle, so this is their only settle point.
 *
 * No `output` is passed, by rule rather than by omission: a child loop's
 * product is the per-turn delivery routed to its parent (and the result
 * manifest a strategy persists beside it), not a flow output. Its `run.end`
 * row therefore carries an empty output.
 */
const finalizeChildRun = Effect.fn('finalizeChildRun')(function* (
  args: FinalizeChildRunArgs,
) {
  const { handle, session, logger, closeTrace, options } = args;
  // Only a child a parent can continue pauses: a detached one (no parent)
  // has nobody to call it again, so its stop cancels it.
  const parentRunId = handle.parentState.current;
  const pause =
    options.outcome === RUN_OUTCOME.CANCELLED && parentRunId !== null
      ? options.pauseNotice?.()
      : undefined;
  if (pause !== undefined && parentRunId !== null)
    return yield* pauseChildRun(args, pause, parentRunId);

  // Describing the failure is fallible: `error` is `unknown`, and formatting
  // a foreign value can throw (a throwing `message` getter or `toString`).
  // That must never keep `finalizeRunTerminal` below from running, or the
  // handle stays tracked and the run never gets its `run.end` row.
  const described = yield* Effect.exit(
    Effect.sync(() => {
      if (options.outcome !== RUN_OUTCOME.FAILED) return undefined;
      const message =
        options.error != null ? toErrorMessage(options.error) : undefined;
      if (message) logger.error(message);
      return {
        kind: classifyAgentError(options.error),
        message: message ?? 'Child run failed',
      };
    }),
  );
  if (Exit.isFailure(described)) {
    logger.error('Child run finalize prologue failed', {
      data: { error: Cause.squash(described.cause) },
    });
  }

  // What the child saw, in the shared vocabulary. Which of this and an
  // already-landed stop is the run's terminal fact is decided upstream: the
  // loop derives the outcome from its own interrupted signal, and
  // `finalizeRunTerminal` applies that stop precedence.
  const finalized = yield* finalizeRunTerminal({
    session,
    handle,
    ...(Exit.isSuccess(described)
      ? { outcome: options.outcome, error: described.value }
      : {
          outcome: RUN_OUTCOME.FAILED,
          error: {
            kind: 'unexpected' as const,
            message: 'Child run finalize prologue failed',
          },
        }),
    stage: options.stage,
    stopped: options.stopped,
    settle: () => Effect.succeed(options.settlement ?? []),
  });
  closeTrace();

  // The port's contract is "resolves once the terminal finalizer has
  // persisted": a `run.end` row that never wrote is this finalize's failure,
  // so the loop's cleanup aggregation fails the loop over it rather than
  // report a child whose terminal fact is gone.
  if (finalized.persistFailure !== undefined) {
    return yield* Effect.fail(
      new Error(`Child run ${handle.runId} terminal state was not persisted`, {
        cause: finalized.persistFailure,
      }),
    );
  }
}, Effect.uninterruptible);

/**
 * Rest a stopped child that its parent's model can continue, instead of
 * ending it: one batch commits the notice as its report with the `child.park`
 * `paused` row carrying the resume id (not `run.end`), so the pause is
 * durable before anything tells the parent; only then is the notice queued
 * for the parent's next input, waking nobody. Calling the child again activates it
 * once more. The handle is untracked and the trace closed whatever the writes
 * did, so the registry never keeps a finished generation live.
 */
const pauseChildRun = (
  { handle, session, logger, closeTrace, options }: FinalizeChildRunArgs,
  { text: notice, resumeId }: ChildRunPause,
  parentRunId: RunId,
) =>
  Effect.gen(function* () {
    const runId = handle.runId;
    const text = formatDelivery({
      tag: DELIVERY_TAG.childPaused,
      runId,
      lines: [escapeText(notice)],
    });
    options.stage?.end(RUN_OUTCOME.CANCELLED);
    const target = aggregateId('run', runId);
    // The last turn's settlement first: the pause notice is the newer report.
    yield* session.log.transact([
      ...(options.settlement ?? []),
      { type: 'run.report', aggregateId: target, report: text },
      { type: 'child.park', aggregateId: target, phase: 'paused', resumeId },
    ]);
    const from = { kind: 'run', runId } as const;
    // Read with the parent's next input and offered to nobody: a pause
    // starts no model turn, parked or busy, and wakes no parent.
    // The pause is durable by now: a failed admission loses only the
    // notice, which the report keeps, so it is warned about, never raised.
    const submitted = yield* session.followUps
      .send(parentRunId, { text, from }, { hold: 'instruction' })
      .pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            logger.warn(
              `Paused child ${runId}: its notice could not be queued for parent run ${parentRunId}; it remains in this run's report.`,
              { data: error },
            );
            return { kind: 'failed' } as const;
          }),
        ),
      );
    if (submitted.kind === 'refused')
      logger.warn(
        `The pause notice was not queued for parent run ${parentRunId}; it remains in this run's report.`,
      );
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        (yield* Runs).untrackIfCurrent(handle);
        closeTrace();
      }),
    ),
    Effect.withSpan('pauseChildRun'),
  );

/**
 * The run an agent-CLI launch registers: the paused child of `parentRunId`
 * whose pause kept `resumeId`, reactivated rather than left paused beside a
 * new run, else a fresh id. Read from the rows (each run's latest
 * `child.park`, and the fold's paused reading), not from a live registry, so
 * it holds across a restart.
 */
export const agentCliChildRunId = Effect.fn('agentCliChildRunId')(function* ({
  session,
  parentRunId,
  resumeId,
}: {
  readonly session: SessionHandle;
  readonly parentRunId: RunId;
  readonly resumeId?: string;
}) {
  if (resumeId === undefined) return generateRunId();
  // Only the pauses that kept `resumeId` are collected, not the session.
  const [view, parks] = yield* Effect.all([
    session.view.read([]),
    Stream.runCollect(
      session.log
        .listing()
        .pipe(
          Stream.filter(
            (row) => row.type === 'child.park' && row.resumeId === resumeId,
          ),
        ),
    ),
  ]).pipe(Effect.mapError((e) => new ToolError(toErrorMessage(e))));
  for (const row of parks) {
    const target = aggregateTarget(row.aggregateId);
    if (target.kind !== 'run') continue;
    const run = view.runs.get(target.id);
    if (run?.substate === RUN_SUBSTATE.PAUSED && run.parentId === parentRunId)
      return target.id;
  }
  return generateRunId();
});
