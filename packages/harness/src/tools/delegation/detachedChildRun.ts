/**
 * Shared detached-child launch choreography for delegation launch sites.
 *
 * Every detached child run (an `agent` subagent, a background script)
 * starts with the same lifecycle: hold the owned-run launch guard
 * from child-stream creation through child-run-loop handoff, and attach a
 * completion error trace so a late loop failure is diagnosed. Callers keep
 * their own run-id derivation, approval wiring, and result shaping; this
 * module owns the guard-and-trace skeleton so its invariant (a throw inside
 * the guard releases the claim; a late loop failure is surfaced) lives in one
 * place.
 */
// Third-party imports
import { Cause, Effect, Exit, Fiber } from 'effect';

// Local imports
import type { AgentRunServices, Runs } from '@agent/runtime/runRegistry';
import { runWithLaunchGuard } from '@agent/runtime/runLaunchGuard';
import {
  startChildRunLoop,
  type ChildRunLoopParams,
  type ChildRunPort,
  type ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import { registerRun } from '@agent/storage/runLifecycle';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { withLogChannel } from '@logger/effectLog';
import {
  RUN_OUTCOME,
  USER_FOLLOW_UP_SUPPORT,
  type RunId,
  type RunIdentity,
} from '@shared/schemas';
import {
  childRunDescription,
  createChildRun,
  resumedChildRunId,
} from './childRun';

/**
 * Everything the choreography forwards to the child run loop verbatim: the
 * loop owns these field contracts, and the two members the guard supplies
 * itself (`strategy` from `buildLaunch`, `childRun` from
 * `createChildRun`) are the only ones a launch site does not pass through.
 */
type DetachedChildRunInputBase = Omit<
  ChildRunLoopParams<never>,
  'strategy' | 'childRun'
>;

export type DetachedChildRunInput<
  TTurn,
  R = never,
> = DetachedChildRunInputBase &
  (
    | {
        /** Create the stream inside the launch guard, before any stream-dependent setup. */
        readonly createChildRun: () => Effect.Effect<ChildRunPort, Error, Runs>;
        /** Build attempt-scoped setup around the stream retained by the launch
         * guard. It runs in the choreography's own context, so it may read the
         * session's `Runs` (the agent-CLI strategies resolve their registry there). */
        readonly buildLaunch: (
          childRun: ChildRunPort,
        ) => Effect.Effect<ChildRunStrategy<TTurn, R>, Error, R | Runs>;
      }
    | {
        /** Native strategies let `executeAgent` own one handle for the native lifetime. */
        readonly createChildRun?: undefined;
        /**
         * Build the strategy (and any attempt-scoped setup) inside the owned-run
         * launch guard so a throw releases the run's claim.
         */
        readonly buildLaunch: () => Effect.Effect<
          ChildRunStrategy<TTurn, R>,
          Error,
          R | Runs
        >;
      }
  );

/**
 * Run the shared detached-child launch choreography: hold the owned-run
 * launch guard while creating any child stream and handing it to the run
 * loop, then attach the completion error trace. Returns the launched loop's
 * completion so in-band callers can await it.
 */
export function startDetachedChildRunLoop<
  TTurn,
  R extends AgentRunServices = never,
>(
  input: DetachedChildRunInput<TTurn, R>,
): Effect.Effect<
  { completion: Fiber.Fiber<TTurn | undefined, Error> },
  Error,
  R | Runs
> {
  return runWithLaunchGuard(
    input.session,
    input.runId,
    Effect.gen(function* () {
      let childRun: ChildRunPort | undefined;
      const setup = yield* Effect.exit(
        Effect.gen(function* () {
          let strategy: ChildRunStrategy<TTurn, R>;
          if (input.createChildRun) {
            childRun = yield* input.createChildRun();
            strategy = yield* input.buildLaunch(childRun);
          } else {
            strategy = yield* input.buildLaunch();
          }
          const {
            createChildRun: _createChildRun,
            buildLaunch: _buildLaunch,
            ...loopParams
          } = input;
          const completion = yield* startChildRunLoop({
            ...loopParams,
            ...(childRun !== undefined && { childRun }),
            strategy,
          });
          return completion;
        }),
      );
      if (Exit.isFailure(setup)) {
        const error = Cause.squash(setup.cause);
        if (childRun) {
          const finalized = yield* Effect.exit(
            childRun.finalize({
              outcome: RUN_OUTCOME.FAILED,
              error,
            }),
          );
          if (Exit.isFailure(finalized)) {
            return yield* Effect.fail(
              new AggregateError(
                [error, Cause.squash(finalized.cause)],
                `Detached child run ${input.runId} failed and its child stream could not be finalized`,
              ),
            );
          }
        }
        return yield* Effect.failCause(setup.cause);
      }
      const completion = setup.value;
      // An awaiting caller (`onTurnSettled`) owns the loop's failure; nobody
      // reads a detached loop's, so a late failure is diagnosed here: on the
      // child's own trace when it has one, else on the loop's log channel.
      if (input.onTurnSettled === undefined) {
        const message = `Child '${input.agentName}' run loop failed after launch`;
        yield* Effect.forkDetach(
          Fiber.join(completion).pipe(
            Effect.catchCause((cause) => {
              const error = Cause.squash(cause);
              const trace = childRun?.logger;
              return trace
                ? Effect.sync(() => trace.error(message, { data: error }))
                : Effect.logError(message).pipe(
                    Effect.annotateLogs({ data: error }),
                    withLogChannel('childRunLoop'),
                  );
            }),
          ),
        );
      }
      return { completion };
    }),
  ).pipe(Effect.uninterruptible);
}

/**
 * A child run an external process drives, launched from a plugin's tool:
 * how it reads (`identity`), its record, its task label, and the strategy
 * its loop runs, built around the child stream the launch created. With
 * `resumeId`, the paused child of the caller that kept that id is
 * activated again instead of a new run.
 */
export interface ProcessChildLaunch<TTurn> {
  readonly identity: Extract<RunIdentity, { kind: 'agent' }>;
  readonly config: AgentConfig;
  readonly description: string;
  readonly resumeId?: string;
  readonly buildLaunch: (ctx: {
    readonly childRun: ChildRunPort;
    readonly runId: RunId;
  }) => Effect.Effect<ChildRunStrategy<TTurn>, Error>;
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
        budgeted: false,
        // The one interruption checkpoint: from here to the started loop is
        // uninterruptible, so a cancel arriving once the record committed
        // leaves the run CANCELLED with no loop behind it.
        createChildRun: () =>
          restore(Effect.void).pipe(
            Effect.andThen(
              createChildRun(session, runId, parentRunId, launch.identity),
            ),
          ),
        buildLaunch: (childRun) => launch.buildLaunch({ childRun, runId }),
      }).pipe(Effect.orDie);
      return runId;
    }),
  );
