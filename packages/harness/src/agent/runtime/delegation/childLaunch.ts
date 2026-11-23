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
import { Effect } from 'effect';

import {
  prepareAgentDefinition,
  type PreparedAgentDefinition,
} from '@agent/runtime/AgentLaunchContext';
import {
  executeAgent,
  type ExecuteAgentOptions,
} from '@agent/runtime/executeAgent';
import { openResume } from '@agent/runtime/resumeRun';
import type { RunToolCall } from '@agent/runtime/RunCall';
import { RunRegistry, type AgentRunServices } from '@agent/runtime/runRegistry';
import { getRunRecords } from '@agent/storage/runOwnership';
import { logFailure } from '@logger/effectLog';
import {
  runEndErrorMessage,
  RUN_OUTCOME,
  ToolError,
  type CommitOrdinal,
  type RunEnd,
  type RunId,
  type SubagentProgressUpdate,
  type AgentConfig,
} from '@shared/schemas';
import type { RegisterRunOptions } from '@shared/session/runFacts';

/** What a child's end answers its awaiting call. */
export interface ChildRunEnd {
  readonly runId: RunId;
  readonly result: RunEnd;
}

/** The parent edge of a child `call` launches: the calling run, and the
 *  call and its card, which await the child or send it to the background. */
export const childOf = (
  call: RunToolCall,
  awaited: boolean,
): NonNullable<RegisterRunOptions['parent']> => ({
  id: call.run.runId,
  call: { callId: call.callId, card: call.logId, awaited },
});

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
  options: Pick<ExecuteAgentOptions, 'onProgress'> = {},
): Effect.fn.Return<CommitOrdinal, Error, AgentRunServices> {
  const { opened } = yield* (yield* RunRegistry).start(
    runId,
    executeAgent(
      runId,
      registration.parent?.id ?? null,
      Effect.succeed({
        definition,
        options: { ...options, entry: { kind: 'fresh', registration } },
      }),
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
const CHANNEL = 'childLaunch';

const resumeOwnedChild = Effect.fn('resumeOwnedChild')(function* (
  runId: RunId,
  parentId: RunId,
  onProgress: ExecuteAgentOptions['onProgress'],
): Effect.fn.Return<CommitOrdinal, Error, AgentRunServices> {
  const { opened } = yield* (yield* RunRegistry).start(
    runId,
    executeAgent(
      runId,
      parentId,
      openResume(runId, { onProgress }, parentId).pipe(
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
const awaitChildRun = (
  call: RunToolCall,
  runId: RunId,
  start: Effect.Effect<unknown, Error, AgentRunServices>,
): Effect.Effect<ChildRunEnd, Error, AgentRunServices> =>
  call.run.awaitedCalls.withPermits(1)(childRunEnd(runId, start));

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
            logFailure(
              CHANNEL,
              `Subagent ${runId}: its release was not recorded`,
            )(cause).pipe(
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

/** What a fresh child's `run.start` carries beyond its identity and its
 *  parent edge, as its launching call decided it. */
export type ChildRegistration = Pick<
  RegisterRunOptions,
  'grants' | 'maxCostUsd' | 'seed'
>;

/** Launch one child of `call` under the run id the call derived and read
 *  its end back; recovering an earlier attempt belongs to the caller that
 *  owns the call identity (`recoverAgentChild`). The child takes the keys
 *  the calling run's launch brought, and `notify` gets its progress for
 *  the call's card. */
export const executeSubagentInBand = (
  call: RunToolCall,
  runId: RunId,
  config: AgentConfig,
  registration: ChildRegistration,
  notify: (update: SubagentProgressUpdate) => void,
): Effect.Effect<ChildRunEnd, Error, AgentRunServices> =>
  awaitChildRun(
    call,
    runId,
    Effect.flatMap(prepareAgentDefinition({ config }), (definition) =>
      startChildRun(
        runId,
        definition,
        {
          ...registration,
          identity: { kind: 'agent', agent: definition.config.label },
          parent: childOf(call, true),
        },
        { onProgress: notify },
      ),
    ),
  );

/** Resume the persisted child `runId` of `call` under the id it already
 *  has and await it as {@link executeSubagentInBand} awaits a launch. */
export const resumeSubagentInBand = (
  call: RunToolCall,
  runId: RunId,
  notify: (update: SubagentProgressUpdate) => void,
): Effect.Effect<ChildRunEnd, Error, AgentRunServices> =>
  awaitChildRun(call, runId, resumeOwnedChild(runId, call.run.runId, notify));
