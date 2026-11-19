/**
 * How a parent's call launches a native child, and how it awaits one.
 *
 * Every native child (an `agent` call's subagent, a `script` sent to the
 * background, a goal round through `self()`) is `executeAgent` under a
 * parent edge, so it runs one cycle: it ends with its `run.end`, whose transaction delivers
 * its report to the parent's input unless the call awaits it
 * (`RunParent.call.awaited`). The run is forked on the session's registry
 * under its id and opens on its own fiber; the call waits for its opening,
 * so a launch that fails before the run exists fails the call, and the run
 * outlives the call that started it: a background child whose launching
 * call is interrupted while it opens goes on opening. An awaited call reads
 * the child's end once the run here has ended; interrupting the call, the
 * child opening or running, stops the child (`released`), unless the stop
 * detached it (`RunRegistry.stop`), in which case it runs on as a root and
 * only the wait ends.
 */
import { Effect, Schema } from 'effect';

import {
  prepareAgentDefinition,
  type PreparedAgentDefinition,
} from '@agent/runtime/AgentLaunchContext';
import {
  executeAgent,
  type ExecuteAgentOptions,
} from '@agent/runtime/executeAgent';
import { openResume } from '@agent/runtime/resumeRun';
import { RunCall } from '@agent/runtime/RunCall';
import { RunRegistry, type AgentRunServices } from '@agent/runtime/runRegistry';
import { getRunRecords } from '@agent/storage/runOwnership';
import type { ApprovalGrants } from '@shared/approvalBypassKind';
import {
  runEndErrorMessage,
  AgentConfigSchema,
  RUN_OUTCOME,
  ToolError,
  type CommitOrdinal,
  type RunEnd,
  type RunId,
  type RunParent,
  type SubagentProgressUpdate,
  type AgentConfigPayload,
} from '@shared/schemas';
import type { RegisterRunOptions } from '@shared/session/runFacts';

/** What a child's end answers its awaiting call. */
interface ChildRunEnd {
  readonly runId: RunId;
  readonly result: RunEnd;
}

/**
 * Start a fresh native child on the session's registry, forked under its
 * id, its opening (its registration batch) on its own fiber. Answers the
 * commit of its opening; a launch that fails before the run exists fails
 * this with no run behind it. The registry carries the launching call's
 * `LaunchKeys` onto the child, so it takes the parent's, awaited or not.
 */
export const startChildRun = Effect.fn('startChildRun')(function* (
  runId: RunId,
  definition: PreparedAgentDefinition,
  registration: RegisterRunOptions,
  options: Pick<ExecuteAgentOptions, 'onProgress' | 'tools'> = {},
): Effect.fn.Return<CommitOrdinal, Error, AgentRunServices> {
  const { opened } = yield* (yield* RunRegistry).start(
    runId,
    executeAgent(
      runId,
      Effect.succeed({ definition, options: { ...options, registration } }),
    ),
  );
  return opened.activation;
});

/**
 * Resume the child `runId` of `parentId` that its open call owns, through
 * the one resume path (`openResume`, which lets the owner through where it
 * sends any other caller to the owner): the run continues from its rows
 * under its stored configuration, one cycle, on the session's registry.
 * Refused when its rows cannot continue.
 */
const resumeOwnedChild = Effect.fn('resumeOwnedChild')(function* (
  runId: RunId,
  parentId: RunId,
  options: Pick<ExecuteAgentOptions, 'onProgress'>,
): Effect.fn.Return<CommitOrdinal, Error, AgentRunServices> {
  const { opened } = yield* (yield* RunRegistry).start(
    runId,
    executeAgent(
      runId,
      openResume(runId, options, parentId).pipe(
        Effect.catchTag('ResumeNotOpened', ({ answer }) =>
          Effect.fail(
            new ToolError(
              'failed' in answer
                ? `Subagent ${runId} cannot be resumed here (${answer.failed.kind}).`
                : `Subagent ${runId} belongs to an open call of ${answer.ownedBy}.`,
            ),
          ),
        ),
      ),
    ),
  );
  return opened.activation;
});

/**
 * Await the child `runId` this call owns: `start` opens it (a launch or a
 * resume), then the call waits for the run here to end and reads its end.
 * No end, or a failed one, fails with the child's error; any other end is
 * the answer, its output as the run recorded it. The call holds one of
 * its run's awaited-call permits throughout (`AgentRun.awaitedCalls`): at
 * most the child-run budget of a run's awaited children run at once.
 */
const awaitChildRun = Effect.fn('awaitChildRun')(function* (
  runId: RunId,
  start: Effect.Effect<unknown, Error, AgentRunServices>,
): Effect.fn.Return<ChildRunEnd, Error, AgentRunServices | RunCall> {
  const call = yield* RunCall;
  return yield* call.run.awaitedCalls.withPermits(1)(childRunEnd(runId, start));
});

/** {@link awaitChildRun}'s wait, under its permit. */
const childRunEnd = Effect.fn('childRunEnd')(function* (
  runId: RunId,
  start: Effect.Effect<unknown, Error, AgentRunServices>,
): Effect.fn.Return<ChildRunEnd, Error, AgentRunServices> {
  const runs = yield* RunRegistry;
  // The call let go, the child opening or running: the child's stop says
  // so, unless a stop of it (its parent's cascade) already did. Nobody
  // else reads an awaited child's end, so it does not run on unread. A
  // child that never reached the registry has nothing to release.
  const release = Effect.suspend(() =>
    runs.get(runId) === undefined
      ? Effect.void
      : runs.stop(runId, 'released').pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `Subagent ${runId}: its release was not recorded`,
            ).pipe(
              Effect.annotateLogs({ data: cause }),
              Effect.andThen(Effect.sync(() => runs.interrupt(runId))),
            ),
          ),
          Effect.andThen(runs.awaitDrained(runId)),
        ),
  );
  yield* start.pipe(Effect.onInterrupt(() => release));
  const live = runs.get(runId);
  // What the child's fiber failed on, when it did: the reason an end is
  // missing below (the store refused it).
  const unsaved =
    live && (yield* live.drained.pipe(Effect.onInterrupt(() => release)));
  const result = yield* getRunRecords(runId).readRunEnd();
  if (result === null)
    return yield* unsaved === undefined
      ? new ToolError(`Subagent ${runId} ended without a recorded end.`)
      : new ToolError(
          `Subagent ${runId} ended without a recorded end: ${unsaved.message}`,
          { cause: unsaved },
        );
  if (result.outcome === RUN_OUTCOME.FAILED)
    return yield* new ToolError(
      result.error === undefined
        ? `Subagent ${runId} ended with failed outcome.`
        : runEndErrorMessage(result.error),
    );
  return { runId, result };
});

/** What an awaited child's launch takes. */
interface AwaitedChildLaunch {
  /** The launching run: the child's parent edge. */
  readonly parentId: RunId;
  /** The run this attempt executes under; the caller owns its derivation. */
  readonly runId: RunId;
  readonly configPayload: AgentConfigPayload;
  /** The parent's call that launches the child, which owns it and awaits
   *  its end, and its tool card. */
  readonly parentCall: Omit<NonNullable<RunParent['call']>, 'awaited'>;
  /** The grants a fresh child is registered with. */
  readonly grants?: ApprovalGrants;
  /** The history a fresh child is born on: a fork's (`forkSeed`). */
  readonly seed?: RegisterRunOptions['seed'];
  /** Live progress for the call's card; absent means silent. */
  readonly notify?: (update: SubagentProgressUpdate) => void;
}

/** Launch one child under the run id its caller derived and read its end
 *  back; recovering an earlier attempt belongs to the caller that owns the
 *  call identity (`recoverAgentChild`). The child takes the keys the
 *  calling run's launch brought. */
export const executeSubagentInBand = (
  launch: AwaitedChildLaunch,
): Effect.Effect<ChildRunEnd, Error, AgentRunServices | RunCall> =>
  awaitChildRun(
    launch.runId,
    Effect.gen(function* () {
      const definition = yield* prepareAgentDefinition({
        config: Schema.decodeUnknownSync(AgentConfigSchema)(
          launch.configPayload,
        ),
      });
      return yield* startChildRun(
        launch.runId,
        definition,
        {
          identity: { kind: 'agent', agent: definition.config.agent },
          parent: {
            id: launch.parentId,
            call: { ...launch.parentCall, awaited: true },
          },
          grants: launch.grants,
          seed: launch.seed,
        },
        { onProgress: launch.notify },
      );
    }),
  );

/** Resume a persisted child under the run id it already has and await it
 *  as {@link executeSubagentInBand} awaits a launch. */
export const resumeSubagentInBand = (
  launch: Pick<AwaitedChildLaunch, 'runId' | 'parentId' | 'notify'>,
): Effect.Effect<ChildRunEnd, Error, AgentRunServices | RunCall> =>
  awaitChildRun(
    launch.runId,
    resumeOwnedChild(launch.runId, launch.parentId, {
      onProgress: launch.notify,
    }),
  );
