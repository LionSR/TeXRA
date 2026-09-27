import { Cause, Effect, Exit, Fiber } from 'effect';
import type { Runs } from '@agent/runtime/runRegistry';
/**
 * Shared detached-child launch choreography for delegation launch sites.
 *
 * Every detached child run (delegate_agent/subagent, delegate_multi_agents)
 * starts with the same lifecycle: hold the owned-run launch guard
 * from child-stream creation through child-run-loop handoff, and attach a
 * completion error trace so a late loop failure is diagnosed. Callers keep
 * their own run-id derivation, approval wiring, and result shaping; this
 * module owns the guard-and-trace skeleton so its invariant (a throw inside
 * the guard releases the claim; a late loop failure is surfaced) lives in one
 * place.
 */

// Third-party imports

// Local imports
import {
  startChildRunLoop,
  runWithLaunchGuard,
  type ChildRunLoopParams,
  type ChildRunPort,
  type ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import type { AgentResume } from '@platform/interfaces';
import { RUN_OUTCOME } from '@shared/schemas';

/** The strategy wiring a launch site supplies inside the guard. */
export interface DetachedChildRunLaunch<TTurn, R = never> {
  /** Provider-specific run strategy for the child loop. */
  readonly strategy: ChildRunStrategy<TTurn, R>;
  /**
   * Attach a completion error trace so a late loop failure is diagnosed. Omit
   * when the caller awaits completion in-band (no unhandled rejection).
   */
  readonly onLoopFailed?: (error: unknown) => Effect.Effect<void>;
}

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
        ) => Effect.Effect<DetachedChildRunLaunch<TTurn, R>, Error, R | Runs>;
      }
    | {
        /** Native strategies let `executeAgent` own one handle for the native lifetime. */
        readonly createChildRun?: undefined;
        /**
         * Build the strategy (and any attempt-scoped setup) inside the owned-run
         * launch guard so a throw releases the run's claim.
         */
        readonly buildLaunch: () => Effect.Effect<
          DetachedChildRunLaunch<TTurn, R>,
          Error,
          R | Runs
        >;
      }
  );

/**
 * Run the shared detached-child launch choreography: hold the owned-run
 * owned-run launch guard while creating any child stream and handing it to the run
 * loop, then attach the completion error trace. Returns the launched loop's
 * completion so in-band callers can await it.
 */
export function startDetachedChildRunLoop<TTurn, R = never>(
  input: DetachedChildRunInput<TTurn, R>,
): Effect.Effect<
  { completion: Fiber.Fiber<TTurn | undefined, Error> },
  Error,
  R | Runs | AgentResume
> {
  return runWithLaunchGuard(
    input.session,
    input.runId,
    Effect.gen(function* () {
      let childRun: ChildRunPort | undefined;
      const setup = yield* Effect.exit(
        Effect.gen(function* () {
          let launch: DetachedChildRunLaunch<TTurn, R>;
          if (input.createChildRun) {
            childRun = yield* input.createChildRun();
            launch = yield* input.buildLaunch(childRun);
          } else {
            launch = yield* input.buildLaunch();
          }
          const {
            createChildRun: _createChildRun,
            buildLaunch: _buildLaunch,
            budgeted,
            ...loopParams
          } = input;
          const completion = yield* startChildRunLoop({
            ...loopParams,
            ...(childRun !== undefined && { childRun }),
            strategy: launch.strategy,
            // An awaited in-band child rides its idle parent's budget slot.
            budgeted: budgeted ?? true,
          });
          return { launch, completion };
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
      const { launch, completion } = setup.value;
      if (launch.onLoopFailed) {
        const onLoopFailed = launch.onLoopFailed;
        yield* Effect.forkDetach(
          Fiber.join(completion).pipe(
            Effect.catchCause((cause) => onLoopFailed(Cause.squash(cause))),
          ),
        );
      }
      return { completion };
    }),
  ).pipe(Effect.uninterruptible);
}
