import { Cause, Effect, Exit, Fiber } from 'effect';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
/**
 * Shared detached-child launch choreography for delegation launch sites.
 *
 * Every detached child run (delegate_agent/subagent, delegate_multi_agents)
 * starts with the same lifecycle: hold the owned-execution lease launch guard
 * from child-stream creation through child-run-loop handoff, and attach a
 * completion error trace so a late loop failure is diagnosed. Callers keep
 * their own execution-id derivation, approval wiring, and result shaping; this
 * module owns the guard-and-trace skeleton so its invariant (a throw inside
 * the guard releases the lease; a late loop failure is surfaced) lives in one
 * place, plus native-agent registration that mints the child's stream id.
 */

// Third-party imports

// Local imports
import { registerRun } from '@agent/storage/executionLifecycle';
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
  type StreamTabId,
  type UserFollowUpSupport,
} from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';

// Local file imports
import type { ChildRun } from './childStream';

/**
 * Register a native agent child and take its owned-execution lease. The child
 * is addressed by its run id, the id `buildAgentLaunchContext` publishes its
 * stream under. The stream's identity names the canonical config's `agent`,
 * never `agentName`, which callers resolve differently (an approved
 * override's display name vs. its registry name) and which reaches only the
 * durable child row.
 */
export const registerChildRun = Effect.fn('registerChildExecution')(function* (
  session: SessionHandle,
  input: {
    readonly executionId: RunId;
    /** Canonical config, already parsed by the launch site. */
    readonly config: AgentConfig;
    readonly agentName: string;
    readonly userFollowUpSupport: UserFollowUpSupport;
    readonly parentExecutionId?: RunId;
  },
): Effect.fn.Return<void, Error> {
  const { executionId, config } = input;
  yield* registerRun(session, executionId, config, input.agentName, {
    streamId: executionId,
    identity: { kind: 'agent', agent: config.agent },
    userFollowUpSupport: input.userFollowUpSupport,
    parentExecutionId: input.parentExecutionId,
    background: true,
  });
});

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
 * itself (`strategy` from `buildLaunch`, `childStream` from
 * `createChildStream`) are the only ones a launch site does not pass through.
 */
type DetachedChildRunInputBase = Omit<
  ChildRunLoopParams<never>,
  'strategy' | 'childStream'
>;

export type DetachedChildRunInput<TTurn> = DetachedChildRunInputBase &
  (
    | {
        /** Create the stream inside the lease guard, before any stream-dependent setup. */
        readonly createChildStream: () => Effect.Effect<ChildRun, Error>;
        /** Build attempt-scoped setup around the stream retained by the launch guard. */
        readonly buildLaunch: (
          childStream: ChildRun,
        ) => Effect.Effect<DetachedChildRunLaunch<TTurn>, Error>;
      }
    | {
        /** Native strategies let `executeAgent` own handle creation for every turn. */
        readonly createChildStream?: undefined;
        /**
         * Build the strategy (and any attempt-scoped setup) inside the lease launch
         * guard so a throw releases the owned-execution lease.
         */
        readonly buildLaunch: () => Effect.Effect<
          DetachedChildRunLaunch<TTurn>,
          Error
        >;
      }
  );

/**
 * Run the shared detached-child launch choreography: hold the owned-execution
 * lease launch guard while creating any child stream and handing it to the run
 * loop, then attach the completion error trace. Returns the launched loop's
 * stream id and completion so in-band callers can await it.
 */
export function startDetachedChildRunLoop<TTurn>(
  input: DetachedChildRunInput<TTurn>,
): Effect.Effect<
  {
    childStreamId: StreamTabId;
    completion: Fiber.Fiber<void, Error>;
  },
  Error
> {
  return runWithOwnedRunLeaseLaunchGuard(
    input.session,
    input.executionId,
    Effect.gen(function* () {
      let childStream: ChildRun | undefined;
      let autoCloseOnLaunchFailure = false;
      const setup = yield* Effect.exit(
        Effect.gen(function* () {
          let launch: DetachedChildRunLaunch<TTurn>;
          if (input.createChildStream) {
            childStream = yield* input.createChildStream();
            launch = yield* input.buildLaunch(childStream);
          } else {
            launch = yield* input.buildLaunch();
          }
          autoCloseOnLaunchFailure =
            launch.strategy.autoCloseChildStream === true;
          const {
            createChildStream: _createChildStream,
            buildLaunch: _buildLaunch,
            budgeted,
            ...loopParams
          } = input;
          const completion = yield* startChildRunLoop({
            ...loopParams,
            ...(childStream !== undefined && { childStream }),
            strategy: launch.strategy,
            // An awaited in-band child rides its idle parent's budget slot.
            budgeted: budgeted ?? true,
          });
          return { launch, completion };
        }),
      );
      if (Exit.isFailure(setup)) {
        const error = Cause.squash(setup.cause);
        if (childStream) {
          const finalized = yield* Effect.exit(
            childStream.finalize({
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
                `Detached child execution ${input.executionId} failed and its child stream could not be finalized`,
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
      return {
        childStreamId: childStream?.childStreamId ?? input.childStreamId,
        completion,
      };
    }),
  ).pipe(Effect.uninterruptible);
}
