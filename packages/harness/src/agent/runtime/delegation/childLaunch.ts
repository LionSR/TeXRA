/**
 * How a parent's call launches a native child, and how it awaits one.
 *
 * Every native child (an `agent` call's subagent, a `script` sent to the
 * background, a goal round through `self()`) is `executeAgent` with
 * `stopAfterCycle`: it ends with its `run.end`, whose transaction delivers
 * its report to the parent's input unless the call awaits it
 * (`RunParent.call.awaited`). The run opens in the caller's fiber and is
 * forked on the session's registry under its id, so a launch that fails
 * before the run exists fails the call, and the run outlives the call that
 * started it. An awaited call reads the child's end once the run here has
 * ended; interrupting the call stops the child, unless the stop detached it
 * (`RunRegistry.stop`), in which case it runs on as a root and only the
 * wait ends.
 */
import { Cause, Effect, Schema } from 'effect';

import type { AgentConfigPayload } from '@agent/core/definition/AgentConfig';
import {
  prepareAgentDefinition,
  type PreparedAgentDefinition,
} from '@agent/runtime/AgentLaunchContext';
import {
  executeAgent,
  type ExecuteAgentOptions,
} from '@agent/runtime/executeAgent';
import { RunCall } from '@agent/runtime/RunCall';
import {
  registryOf,
  Runs,
  type AgentRunServices,
} from '@agent/runtime/runRegistry';
import { checkpointRefusal } from '@agent/storage/resumability';
import { getRunRecords } from '@agent/storage/runRecords';
import type { ApprovalGrants } from '@shared/approvalBypassKind';
import {
  AgentConfigSchema,
  RUN_OUTCOME,
  type CommitOrdinal,
  type RunEnd,
  type RunId,
  type RunParent,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import type { RegisterRunOptions } from '@shared/session/runFacts';
import { ensureError } from '@utils/errors/errorMessage';

/** What a child's end answers its awaiting call. */
interface ChildRunEnd {
  readonly runId: RunId;
  readonly result: RunEnd;
}

/** A defect as a failed `Error`; an interruption stays one. */
const defectsAsErrors = <A, R>(
  self: Effect.Effect<A, Error, R>,
): Effect.Effect<A, Error, R> =>
  self.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.fail(ensureError(Cause.squash(cause))),
    ),
  );

/**
 * Start a fresh native child on the session's registry: its opening (its
 * registration batch) in this fiber, its run forked under its id. Answers
 * the commit of its opening; a launch that fails before the run exists
 * fails this with no run behind it.
 */
export const startChildRun = Effect.fn('startChildRun')(function* (
  runId: RunId,
  definition: PreparedAgentDefinition,
  registration: RegisterRunOptions,
  options: Pick<ExecuteAgentOptions, 'onProgress' | 'tools'> = {},
): Effect.fn.Return<CommitOrdinal, Error, AgentRunServices> {
  const { opened } = yield* registryOf(yield* Runs).start(runId, {
    open: executeAgent(definition, runId, { ...options, registration }),
    run: (prepared) => prepared.run,
  });
  return opened.activation;
});

/**
 * Resume the child `runId` of `parentRunId` that its open call owns (the
 * call is this one, so no other resume is asked whether it may): the run
 * continues from its rows under its stored configuration, one cycle, on
 * the session's registry. Refused when its rows cannot continue.
 */
const resumeOwnedChild = Effect.fn('resumeOwnedChild')(function* (
  runId: RunId,
  parentRunId: RunId,
  options: Pick<ExecuteAgentOptions, 'onProgress'>,
): Effect.fn.Return<CommitOrdinal, Error, AgentRunServices> {
  const rejection = yield* checkpointRefusal(runId);
  if (rejection !== null)
    return yield* Effect.fail(
      new Error(
        `Subagent ${runId} cannot be resumed here (${rejection.kind}).`,
      ),
    );
  const config = yield* getRunRecords(runId).readConfig();
  if (config === null)
    return yield* Effect.fail(
      new Error(`Subagent ${runId} has no stored configuration to resume.`),
    );
  const definition = yield* prepareAgentDefinition({
    config,
    stopAfterCycle: true,
  });
  const { opened } = yield* registryOf(yield* Runs).start(runId, {
    open: executeAgent(definition, runId, { ...options, parentRunId }),
    run: (prepared) => prepared.run,
  });
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
): Effect.fn.Return<ChildRunEnd, Error, AgentRunServices> {
  const call = yield* RunCall;
  if (call === null)
    return yield* Effect.fail(
      new Error(`Subagent ${runId} is awaited outside a tool call.`),
    );
  return yield* call.run.awaitedCalls.withPermits(1)(childRunEnd(runId, start));
}, defectsAsErrors);

/** {@link awaitChildRun}'s wait, under its permit. */
const childRunEnd = Effect.fn('childRunEnd')(function* (
  runId: RunId,
  start: Effect.Effect<unknown, Error, AgentRunServices>,
): Effect.fn.Return<ChildRunEnd, Error, AgentRunServices> {
  const runs = registryOf(yield* Runs);
  yield* start;
  const live = runs.get(runId);
  if (live !== undefined)
    yield* live.drained.pipe(
      Effect.onInterrupt(() =>
        Effect.suspend(() => {
          // A child the registry holds with no parent edge was detached:
          // it runs on as a root, and only this wait ends.
          if (
            runs.get(runId) !== undefined &&
            runs.attachedParent(runId) === null
          )
            return Effect.void;
          runs.interrupt(runId);
          return runs.awaitDrained(runId);
        }),
      ),
    );
  const result = yield* getRunRecords(runId).readRunEnd();
  if (result === null)
    return yield* Effect.fail(
      new Error(`Subagent ${runId} ended without a recorded end.`),
    );
  if (result.outcome === RUN_OUTCOME.FAILED)
    return yield* Effect.fail(
      new Error(
        result.error?.message ?? `Subagent ${runId} ended with failed outcome.`,
      ),
    );
  return { runId, result };
});

/** What an awaited child's launch takes. */
interface AwaitedChildLaunch {
  /** The launching run: the child's parent edge. */
  readonly parentRunId: RunId;
  /** The run this attempt executes under; the caller owns its derivation. */
  readonly runId: RunId;
  readonly configPayload: AgentConfigPayload;
  /** The parent's call that launches the child, which owns it, and its
   *  tool card. */
  readonly parentCall?: Omit<NonNullable<RunParent['call']>, 'awaited'>;
  /** The grants a fresh child is registered with. */
  readonly grants?: ApprovalGrants;
  /** The history a fresh child is born on: a fork's (`forkSeed`). */
  readonly seed?: RegisterRunOptions['seed'];
  /** Live progress for the call's card; absent means silent. */
  readonly notify?: (update: SubagentProgressUpdate) => void;
}

/** Launch one child under the run id its caller derived and read its end
 *  back; recovering an earlier attempt belongs to the caller that owns the
 *  call identity (`recoverAgentChild`). */
export const executeSubagentInBand = (
  launch: AwaitedChildLaunch,
): Effect.Effect<ChildRunEnd, Error, AgentRunServices> =>
  awaitChildRun(
    launch.runId,
    Effect.gen(function* () {
      const definition = yield* prepareAgentDefinition({
        config: Schema.decodeUnknownSync(AgentConfigSchema)(
          launch.configPayload,
        ),
        stopAfterCycle: true,
      });
      return yield* startChildRun(
        launch.runId,
        definition,
        {
          identity: { kind: 'agent', agent: definition.config.agent },
          parentRunId: launch.parentRunId,
          ...(launch.parentCall !== undefined && {
            parentCall: { ...launch.parentCall, awaited: true },
          }),
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
  launch: Pick<AwaitedChildLaunch, 'runId' | 'parentRunId' | 'notify'>,
): Effect.Effect<ChildRunEnd, Error, AgentRunServices> =>
  awaitChildRun(
    launch.runId,
    resumeOwnedChild(launch.runId, launch.parentRunId, {
      onProgress: launch.notify,
    }),
  );
