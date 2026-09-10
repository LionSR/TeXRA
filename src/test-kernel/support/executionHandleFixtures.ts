import { Effect } from 'effect';

// Local imports
import type { AgentTrace } from '@agent/trace';
import { RunHandle, type RunDescriptor } from '@agent/runtime/ExecutionHandle';
import { RunRegistry } from '@agent/runtime/executionRegistry';
import { createSessionApprovals } from '@agent/runtime/streamApprovalQueue';
import { RunStatusMachine } from '@agent/runtime/StreamStatusService';
import { AgentCategory } from '@shared/schemas';
import type { RunId, RunIdentity, StreamTabId } from '@shared/schemas';

/**
 * A live execution handle for tests.
 *
 * The run struct is assembled here and typed as the canonical
 * {@link RunDescriptor}, so a schema change breaks every fixture in one place.
 */
export function testExecutionHandle(input: {
  executionId: string;
  parentStreamId: StreamTabId;
  /** Defaults to `parentStreamId`, i.e. a run that is its own parent. */
  childStreamId?: StreamTabId;
  agent: string;
  category?: AgentCategory;
  /** Defaults to a native agent identity for `agent`. */
  identity?: RunIdentity;
  trace?: AgentTrace;
}): RunHandle {
  const streamId = input.childStreamId ?? input.parentStreamId;
  const run: RunDescriptor = {
    streamId,
    executionId: input.executionId as RunId,
    identity: input.identity ?? { kind: 'agent', agent: input.agent },
    category: input.category ?? AgentCategory.ToolUse,
  };
  return new RunHandle(run, input.parentStreamId, input.trace);
}

/** A registry with a status machine whose facts reach its `handleStatus`. */
export function testExecutionRegistry(): RunRegistry {
  // The machine's facts reach the registry built below; the closure runs
  // only once a transition is published, after the registry exists.
  const streamStatus = new RunStatusMachine(
    (event) => registry.handleStatus(event.streamId),
    () => {},
  );
  const registry = new RunRegistry({
    publish: () => {},
    streamStatus,
    approvals: createSessionApprovals({ setApprovalBypassState() {} }),
    publishResult: () => {},
    releaseRootExecutionLease: () => Effect.void,
    finalizeExecution: (input) =>
      Effect.succeed({ ok: true, outcome: input.outcome }),
  });
  return registry;
}
