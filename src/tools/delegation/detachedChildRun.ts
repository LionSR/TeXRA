import { Cause, Effect, Exit, Fiber } from 'effect';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
/**
 * Shared detached-child launch choreography for delegation launch sites.
 *
 * Every detached child run (delegate_agent/subagent, delegate_multi_agents)
 * starts with the same lifecycle: hold the owned-run lease launch guard
 * from child-stream creation through child-run-loop handoff, and attach a
 * completion error trace so a late loop failure is diagnosed. Callers keep
 * their own run-id derivation, approval wiring, and result shaping; this
 * module owns the guard-and-trace skeleton so its invariant (a throw inside
 * the guard releases the lease; a late loop failure is surfaced) lives in one
 * place, plus native-agent registration.
 */

// Third-party imports

// Local imports
import { registerRun } from '@agent/storage/runLifecycle';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  startChildRunLoop,
  runWithOwnedRunLeaseLaunchGuard,
  type ChildRunLoopParams,
  type ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import {
  RUN_OUTCOME,
  type RunId,
  type UserFollowUpSupport,
} from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';

// Local file imports
import type { ChildRun } from './childRun';

/**
 * Register a native agent child and take its owned-run lease. The identity
 * derives from the canonical config's `agent`, never from `agentName`, which
 * callers resolve differently (an approved override's display name vs. its
 * registry name) and which reaches only the durable launch label.
 */
export const registerChildRun = Effect.fn('registerChildRun')(
  function* (
    session: SessionHandle,
    input: {
      readonly runId: RunId;
      /** Canonical config, already parsed by the launch site. */
      readonly config: AgentConfig;
      readonly agentName: string;
      readonly userFollowUpSupport: UserFollowUpSupport;
      readonly parentRunId?: RunId;
    },
  ): Effect.fn.Return<void, Error> {
    const { runId, config } = input;
    yield* registerRun(session, runId, config, input.agentName, {
      identity: { kind: 'agent', agent: config.agent },
      userFollowUpSupport: input.userFollowUpSupport,
      parentRunId: input.parentRunId,
    });
  },
);

/** The strategy wiring a launch site supplies inside the guard. */
interface DetachedChildRunLaunch<TTurn> {
  /** Provider-specific run strategy for the child loop. */
  readonly strategy: ChildRunStrategy<TTurn>;
  /**
   * Attach a completion error trace so a late loop failure is diagnosed. Omit
   * when the caller awaits completion in-band (no unhandled rejection).
   */
  readonly onLoopFailed?: (error: unknown) => void;
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

export type DetachedChildRunInput<TTurn> = DetachedChildRunInputBase &
  (
    | {
        /** Create the stream inside the lease guard, before any stream-dependent setup. */
        readonly createChildRun: () => Effect.Effect<ChildRun, Error>;
        /** Build attempt-scoped setup around the stream retained by the launch guard. */
        readonly buildLaunch: (
          childRun: ChildRun,
        ) => Effect.Effect<DetachedChildRunLaunch<TTurn>, Error>;
      }
    | {
        /** Native strategies let `executeAgent` own handle creation for every turn. */
        readonly createChildRun?: undefined;
        /**
         * Build the strategy (and any attempt-scoped setup) inside the lease launch
         * guard so a throw releases the owned-run lease.
         */
        readonly buildLaunch: () => Effect.Effect<
          DetachedChildRunLaunch<TTurn>,
          Error
        >;
      }
  );

/**
 * Run the shared detached-child launch choreography: hold the owned-run
 * lease launch guard while creating any child stream and handing it to the run
 * loop, then attach the completion error trace. Returns the launched loop's
 * stream id and completion so in-band callers can await it.
 */
export function startDetachedChildRunLoop<TTurn>(
  input: DetachedChildRunInput<TTurn>,
): Effect.Effect<
  {
    childRunId: RunId;
    completion: Fiber.Fiber<void, Error>;
  },
  Error
> {
  return runWithOwnedRunLeaseLaunchGuard(
    input.session,
    input.runId,
    Effect.gen(function* () {
      let childRun: ChildRun | undefined;
      let autoCloseOnLaunchFailure = false;
      const setup = yield* Effect.exit(
        Effect.gen(function* () {
          let launch: DetachedChildRunLaunch<TTurn>;
          if (input.createChildRun) {
            childRun = yield* input.createChildRun();
            launch = yield* input.buildLaunch(childRun);
          } else {
            launch = yield* input.buildLaunch();
          }
          autoCloseOnLaunchFailure =
            launch.strategy.autoCloseChildRun === true;
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
              persistence: { kind: 'finalize', flowRecord: 'delete' },
              autoClose: autoCloseOnLaunchFailure,
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
            Effect.catchCause((cause) =>
              Effect.sync(() => onLoopFailed(Cause.squash(cause))),
            ),
          ),
        );
      }
      return { childRunId: input.runId, completion };
    }),
  ).pipe(Effect.uninterruptible);
}
