/**
 * The run program's scaffolding: the run's entry, which opens its one cell,
 * and the exit protocol every run settles. What the loop does between them
 * stays in `toolUse.ts`. There is no hook record: the surface is values and
 * total functions, and the loop writes its own three-argument
 * `Effect.acquireUseRelease`.
 */

import { Context, Effect, Exit, ScopedRef } from 'effect';

import { activationRows } from '@agent/storage/runLifecycle';
import { SessionRoots } from '@platform/rootedFs';
import {
  outcomeFromCause,
  RUN_OUTCOME,
  type RunId,
  type RunOutcome,
} from '@shared/schemas';
import {
  Approvals,
  RunHistory,
  RunHistoryRefused,
  SessionLog,
  type RunCell,
} from '@shared/session/runHistory';
import type { RunState } from '@shared/session/runState';

import { AgentRun } from '../run/AgentRun';
import { registryOf, Runs } from '../runRegistry';
import type { BoundModel } from '../modelAccess/ModelAccess';
import type { FollowUps } from '../FollowUps';

/** What a resume's activation rows read of the session. */
type ActivationServices = SessionLog | SessionRoots | Approvals;

/** Why a run its rows never opened cannot be continued. */
const NOT_RESUMABLE_MESSAGE =
  'This run stopped before it recorded any state to resume from. Start a new run instead.';

/**
 * The refusal of a resume of `runId` from `state`, or null when none is due:
 * a turn the next request replays (an assistant message, the pending
 * response's, or the continuation) was recorded on another protocol than
 * `bound` speaks now, so its provider evidence cannot be sent.
 */
const foreignProtocol = (
  runId: RunId,
  state: RunState,
  bound: Pick<BoundModel, 'backend' | 'origin'>,
): RunHistoryRefused | null => {
  const { pendingResponse, continuation } = state;
  const recorded = [
    ...[
      ...state.messages,
      ...(pendingResponse === null ? [] : [pendingResponse.assistant]),
    ].flatMap((message) =>
      message.role === 'assistant' && message.origin !== null
        ? [message.origin.protocol]
        : [],
    ),
    ...(continuation === null ? [] : [continuation.origin.protocol]),
  ].find((protocol) => protocol !== bound.origin.protocol);
  if (recorded === undefined) return null;
  return new RunHistoryRefused({
    reason: 'foreign-protocol',
    runId,
    detail: `its turns were recorded on ${recorded}, and its ${bound.backend} backend now binds ${bound.origin.protocol}`,
  });
};

/**
 * The run's entry: its cell. A fresh run's registration rides the cell's
 * first append, its opening, so the run exists with its opening or not at
 * all. A resume commits its activation, in one batch, and is refused when
 * the rows hold nothing to continue from. A fresh launch onto a run that
 * already holds history state is refused.
 * The caller opens a cell whose state has no phase.
 */
export const openRun = Effect.fn('runProgram.openRun')(function* (
  runId: RunId,
  resume: boolean,
): Effect.fn.Return<
  RunCell,
  Error,
  RunHistory | AgentRun | ActivationServices
> {
  const runHistory = yield* RunHistory;
  const run = yield* AgentRun;
  // The activation's rows are read in its publisher job, outside this fiber.
  const owners = Context.pick(
    SessionLog,
    SessionRoots,
    Approvals,
  )(yield* Effect.context<ActivationServices>());
  const opened = runHistory.open(
    runId,
    resume
      ? {
          activation: Effect.fn('activation')(function* (
            state: RunState | null,
          ) {
            if (state?.at == null)
              return yield* Effect.fail(new Error(NOT_RESUMABLE_MESSAGE));
            const refused = foreignProtocol(
              runId,
              state,
              yield* ScopedRef.get(run.model),
            );
            if (refused !== null) return yield* refused;
            return yield* activationRows(runId, run.config).pipe(
              Effect.provide(owners),
            );
          }),
        }
      : {
          registration: Effect.succeed(run.entry.registration?.rows ?? []),
        },
  );
  // A resume enters with its activation, with no alongside: its held
  // trace publishes once the activation commits. A fresh run enters with
  // its opening batch later (`openToolUse`); a stop lands before or after.
  const cell = yield* resume
    ? run.entry.enter(() => opened)
    : Effect.uninterruptible(opened);
  if (!resume && (yield* cell.current).at !== null)
    return yield* Effect.fail(
      new Error(
        `Run ${runId} already has run history state; resume it instead.`,
      ),
    );
  return cell;
});

/** What a run program, and each of its turns, returns. */
export type RunExit = {
  readonly state: RunState;
  readonly outcome: RunOutcome;
};

/**
 * The exit protocol, as the release step of the run's acquireUseRelease:
 * the run's input lease, where it holds one. The halt is not written here:
 * it commits with the run's `run.end` (`endRunRows`), so no reader ever
 * sees a stopped run without its end.
 */
export const settleRun =
  (
    cell: RunCell,
    /** The run's own input lease. */
    lease: FollowUps,
  ) =>
  (exit: Exit.Exit<RunExit, Error>): Effect.Effect<void, never, Runs> => {
    // The body's own value when it returned.
    const outcome = Exit.match(exit, {
      onSuccess: (value) => value.outcome,
      onFailure: outcomeFromCause,
    });
    return Effect.flatMap(Runs, (service) =>
      Effect.map(
        registryOf(service).hasLiveDescendants(cell.runId),
        (descendants) =>
          lease.release(
            outcome === RUN_OUTCOME.COMPLETED && !descendants
              ? 'terminal'
              : 'recoverable',
          ),
      ),
    );
  };
