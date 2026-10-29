/**
 * Shared detached-child launch choreography for delegation launch sites.
 *
 * Every detached child run (an `agent` subagent, awaited in band or not, a
 * background script, a background shell, an agent CLI) starts its loop
 * here, and a late loop failure nobody awaits is logged. A process child
 * (a background shell, an agent CLI) is registered before its loop exists,
 * so its trace and strategy are built under the launch guard, which ends
 * the run when that hand-off fails. A native child needs no guard: its run
 * opens on its loop's fiber, whose end is the loop's.
 */
// Third-party imports
import { Cause, Effect, Fiber } from 'effect';

// Local imports
import type { AgentRunServices, Runs } from '@agent/runtime/runRegistry';
import { runWithLaunchGuard } from '@agent/runtime/runLaunchGuard';
import {
  startChildRunLoop,
  type ChildRunLoopParams,
  type ChildRunPort,
  type ProcessChildStrategy,
  type StartedChildRunLoop,
} from '@agent/runtime/childRunLoop';
import { registerRun } from '@agent/storage/runLifecycle';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { AgentTrace } from '@agent/trace';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { withLogChannel } from '@logger/effectLog';
import {
  USER_FOLLOW_UP_SUPPORT,
  type RunId,
  type RunIdentity,
} from '@shared/schemas';
import {
  childRunDescription,
  createChildRun,
  resumedChildRunId,
} from './childRun';

/** A native child's loop parameters, or a process child's with the setup
 *  the launch guard runs: its trace, then its strategy around it. */
type DetachedChildRunInput<TTurn, R> =
  | Extract<ChildRunLoopParams<TTurn, R>, { readonly childRun?: undefined }>
  | (Omit<ChildRunLoopParams<never>, 'strategy' | 'childRun'> & {
      /** Create the stream inside the launch guard, before any stream-dependent setup. */
      readonly createChildRun: () => Effect.Effect<ChildRunPort>;
      /** Build attempt-scoped setup around the stream retained by the launch
       * guard. It runs in the choreography's own context, so it may read the
       * session's `Runs` (the agent-CLI strategies resolve their registry there). */
      readonly buildLaunch: (
        childRun: ChildRunPort,
      ) => Effect.Effect<ProcessChildStrategy<TTurn, R>, Error, R | Runs>;
    });

/**
 * Start a detached child's loop, uninterruptibly. A caller that awaits it
 * (`awaited`) joins its fiber and owns its failure; nobody reads any other
 * loop's, so its late failure is logged ({@link logLateFailure}).
 */
export function startDetachedChildRunLoop<
  TTurn,
  R extends AgentRunServices = never,
>(
  input: DetachedChildRunInput<TTurn, R>,
): Effect.Effect<StartedChildRunLoop<TTurn>, Error, R | Runs> {
  if (!('createChildRun' in input)) {
    const started = startChildRunLoop(input);
    return Effect.uninterruptible(
      input.awaited === true
        ? started
        : Effect.tap(started, (loop) =>
            logLateFailure(input.agentName, loop.fiber),
          ),
    );
  }
  const { createChildRun, buildLaunch, ...loopParams } = input;
  return runWithLaunchGuard(
    input.session,
    input.runId,
    Effect.gen(function* () {
      const port = yield* createChildRun();
      const loop = yield* buildLaunch(port).pipe(
        Effect.flatMap((strategy) =>
          startChildRunLoop({ ...loopParams, childRun: port, strategy }),
        ),
        // A setup that failed before the loop: the guard ends the run.
        Effect.onError(() => Effect.sync(() => port.logger.close())),
      );
      yield* logLateFailure(input.agentName, loop.fiber, port.logger);
      return loop;
    }),
  ).pipe(Effect.uninterruptible);
}

/** Log, detached, how a loop nobody awaits failed: on the loop's log
 *  channel always (the child's trace may be closed by its end by then),
 *  and on the child's trace when it has one. */
const logLateFailure = (
  agentName: string,
  fiber: Fiber.Fiber<unknown, Error>,
  trace?: AgentTrace,
) => {
  const message = `Child '${agentName}' run loop failed after launch`;
  return Effect.forkDetach(
    Fiber.join(fiber).pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        return Effect.sync(() => trace?.error(message, { data: error })).pipe(
          Effect.andThen(
            Effect.logError(message).pipe(
              Effect.annotateLogs({ data: error }),
              withLogChannel('childRunLoop'),
            ),
          ),
        );
      }),
    ),
  );
};

/**
 * A child run an external process drives, launched from a plugin's tool:
 * how it reads (`identity`), its record, its task label, and the strategy
 * its loop runs, built around the trace of the child the launch created. With
 * `resumeId`, the paused child of the caller that kept that id is
 * activated again instead of a new run.
 */
export interface ProcessChildLaunch<TTurn> {
  readonly identity: Extract<RunIdentity, { kind: 'agent' }>;
  readonly config: AgentConfig;
  readonly description: string;
  readonly resumeId?: string;
  readonly buildLaunch: (ctx: {
    readonly logger: AgentTrace;
    readonly runId: RunId;
  }) => Effect.Effect<ProcessChildStrategy<TTurn>, Error>;
}

/**
 * Register a process child of `parentRunId` and start its loop on the
 * detached-launch choreography, outside the child-run budget (an external
 * process on the user's own account, as a background shell is). Answers
 * its run id once the loop owns it; a refused registration fails this, and
 * a setup failure after it dies with the choreography's error.
 */
export const launchProcessChild = <TTurn>(
  session: SessionHandle,
  parentRunId: RunId,
  launch: ProcessChildLaunch<TTurn>,
): Effect.Effect<RunId, Error, Runs> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const runId = yield* resumedChildRunId({
        session,
        parentRunId,
        resumeId: launch.resumeId,
      });
      yield* registerRun(session, runId, launch.config, {
        identity: launch.identity,
        userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.TERMINAL_BACKED,
        parentRunId,
        description: childRunDescription(launch.description),
      });
      yield* startDetachedChildRunLoop({
        session,
        runId,
        parentRunId,
        agentName: launch.identity.agent,
        // The one interruption checkpoint: from here to the started loop is
        // uninterruptible, so a cancel arriving once the record committed
        // leaves the run CANCELLED with no loop behind it.
        createChildRun: () =>
          restore(Effect.void).pipe(Effect.as(createChildRun(session, runId))),
        buildLaunch: (childRun) =>
          launch.buildLaunch({ logger: childRun.logger, runId }),
      }).pipe(Effect.orDie);
      return runId;
    }),
  );
