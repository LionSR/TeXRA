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

// Local imports
import { runWithOwnedExecutionLeaseLaunchGuard } from '@agent/storage/executionLease';
import { registerExecution } from '@agent/storage/executionLifecycle';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  startChildRunLoop,
  type ChildRunLoopParams,
  type ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import { getStreamTabId } from '@agent/runtime/streamTab';
import {
  RUN_OUTCOME,
  type ExecutionId,
  type StreamTabId,
  type UserFollowUpSupport,
} from '@shared/schemas';

// Local file imports
import type { ChildStream } from './childStream';

/**
 * Register a native agent child and take its owned-execution lease, minting
 * the one stream id the child is addressed by.
 *
 * That id must match the one `buildAgentLaunchContext` reserves for this
 * executionId (AgentLaunchContext.ts's `reservedStreamId`), or the loop
 * acquires the wrong follow-up queue/interrupt slot. The reservation derives
 * from the canonical config's `agent` — never from `agentName`, which callers
 * resolve differently (an approved override's display name vs. its registry
 * name) and which reaches only the durable child row. Minting it here is what
 * keeps the two in step: while each launch site derived its own, the
 * invariant could only be stated as a comment asking the copies to agree.
 */
export async function registerChildExecution(input: {
  readonly executionId: ExecutionId;
  /** Canonical config, already parsed by the launch site. */
  readonly config: AgentConfig;
  readonly agentName: string;
  readonly userFollowUpSupport: UserFollowUpSupport;
  readonly parentExecutionId?: ExecutionId;
}): Promise<{ readonly childStreamId: StreamTabId }> {
  const { executionId, config } = input;
  const childStreamId = getStreamTabId(config.agent, { executionId });
  await registerExecution(executionId, config, input.agentName, {
    streamId: childStreamId,
    identity: { kind: 'agent', agent: config.agent },
    userFollowUpSupport: input.userFollowUpSupport,
    parentExecutionId: input.parentExecutionId,
  });
  return { childStreamId };
}

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
        readonly createChildStream: () => ChildStream | Promise<ChildStream>;
        /** Build attempt-scoped setup around the stream retained by the launch guard. */
        readonly buildLaunch: (
          childStream: ChildStream,
        ) => Promise<DetachedChildRunLaunch<TTurn>>;
      }
    | {
        /** Native strategies let `executeAgent` own handle creation for every turn. */
        readonly createChildStream?: undefined;
        /**
         * Build the strategy (and any attempt-scoped setup) inside the lease launch
         * guard so a throw releases the owned-execution lease.
         */
        readonly buildLaunch: () => Promise<DetachedChildRunLaunch<TTurn>>;
      }
  );

/**
 * Run the shared detached-child launch choreography: hold the owned-execution
 * lease launch guard while creating any child stream and handing it to the run
 * loop, then attach the completion error trace. Returns the launched loop's
 * stream id and completion so in-band callers can await it.
 */
export async function startDetachedChildRunLoop<TTurn>(
  input: DetachedChildRunInput<TTurn>,
): Promise<{ childStreamId: StreamTabId; completion: Promise<void> }> {
  return runWithOwnedExecutionLeaseLaunchGuard(input.executionId, async () => {
    let childStream: ChildStream | undefined;
    let launch: DetachedChildRunLaunch<TTurn>;
    let autoCloseOnLaunchFailure = false;
    let completion: Promise<void>;
    try {
      if (input.createChildStream) {
        childStream = await input.createChildStream();
        launch = await input.buildLaunch(childStream);
      } else {
        launch = await input.buildLaunch();
      }
      autoCloseOnLaunchFailure = launch.strategy.autoCloseChildStream === true;
      const {
        createChildStream: _createChildStream,
        buildLaunch: _buildLaunch,
        budgeted,
        ...loopParams
      } = input;
      completion = startChildRunLoop({
        ...loopParams,
        ...(childStream !== undefined && { childStream }),
        strategy: launch.strategy,
        // Every detached native/workflow child takes one shared-budget slot per
        // turn; an awaited in-band child rides its idle parent's slot instead.
        budgeted: budgeted ?? true,
      });
    } catch (error) {
      if (childStream) {
        try {
          await childStream.finalize({
            outcome: RUN_OUTCOME.FAILED,
            error,
            persistence: { kind: 'finalize', flowRecord: 'delete' },
            ...(autoCloseOnLaunchFailure && { autoClose: true }),
          });
        } catch (finalizeError) {
          throw new AggregateError(
            [error, finalizeError],
            `Detached child execution ${input.executionId} failed and its child stream could not be finalized`,
          );
        }
      }
      throw error;
    }

    if (launch.onLoopFailed) void completion.catch(launch.onLoopFailed);
    return {
      childStreamId: childStream?.childStreamId ?? input.childStreamId,
      completion,
    };
  });
}
