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
import {
  runWithOwnedExecutionLeaseLaunchGuard,
  type OwnedExecutionLeaseScope,
} from '@agent/storage/executionLease';
import { registerOwnedExecution } from '@agent/storage/executionLifecycle';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  startChildRunLoop,
  type ChildRunLoopParams,
  type ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import { getStreamTabId } from '@agent/runtime/streamTab';
import type {
  ExecutionId,
  StreamTabId,
  UserFollowUpSupport,
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
}): Promise<{
  readonly childStreamId: StreamTabId;
  readonly runWithOwnership: OwnedExecutionLeaseScope;
}> {
  const { executionId, config } = input;
  const childStreamId = getStreamTabId(config.agent, { executionId });
  const runWithOwnership = await registerOwnedExecution(
    executionId,
    config,
    input.agentName,
    {
      streamId: childStreamId,
      identity: { kind: 'agent', agent: config.agent },
      userFollowUpSupport: input.userFollowUpSupport,
      parentExecutionId: input.parentExecutionId,
    },
  );
  return { childStreamId, runWithOwnership };
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

interface DetachedChildRunInputBase {
  readonly executionId: ExecutionId;
  readonly parentStreamId: StreamTabId;
  /** The child stream tab id the run is registered under. */
  readonly childStreamId: StreamTabId;
  readonly agentName: string;
  /** Roll the child's final cost into the parent's usage totals. */
  readonly recordCost?: (totalCostUsd: number | undefined) => void;
  /**
   * False for an awaited in-band child, which runs while its parent is
   * blocked awaiting it and therefore rides the parent's budget slot (see
   * the child-run budget design note). Detached children default to true.
   */
  readonly budgeted?: boolean;
  /** Progress sink override for awaiting persist-only callers. */
  readonly notify?: ChildRunLoopParams<never>['notify'];
  /** In-memory settled-turn facts for awaiting persist-only callers. */
  readonly onTurnSettled?: ChildRunLoopParams<never>['onTurnSettled'];
  /** Publish caller-owned state after final artifacts drain, before lease release. */
  readonly afterArtifactsDrained?: ChildRunLoopParams<never>['afterArtifactsDrained'];
}

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
    let completion: Promise<void>;
    try {
      if (input.createChildStream) {
        childStream = await input.createChildStream();
        launch = await input.buildLaunch(childStream);
      } else {
        launch = await input.buildLaunch();
      }
      ({ completion } = startChildRunLoop({
        ...(childStream !== undefined && { childStream }),
        childStreamId: input.childStreamId,
        parentStreamId: input.parentStreamId,
        executionId: input.executionId,
        agentName: input.agentName,
        strategy: launch.strategy,
        ...(input.recordCost !== undefined && { recordCost: input.recordCost }),
        ...(input.notify !== undefined && { notify: input.notify }),
        ...(input.onTurnSettled !== undefined && {
          onTurnSettled: input.onTurnSettled,
        }),
        ...(input.afterArtifactsDrained !== undefined && {
          afterArtifactsDrained: input.afterArtifactsDrained,
        }),
        // Every detached native/workflow child takes one shared-budget slot per
        // turn; an awaited in-band child rides its idle parent's slot instead.
        budgeted: input.budgeted ?? true,
      }));
    } catch (error) {
      if (childStream) {
        try {
          await childStream.finalize({
            outcome: { kind: 'failed', error },
            persistence: { kind: 'finalize', flowRecord: 'delete' },
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
