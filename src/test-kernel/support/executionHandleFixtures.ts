// Local imports
import type { AgentTrace } from '@agent/trace';
import {
  AgentExecutionHandle,
  type ExecutionRun,
} from '@agent/runtime/ExecutionHandle';
import { ExecutionRegistry } from '@agent/runtime/executionRegistry';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import { AgentCategory } from '@shared/schemas';
import type { ExecutionId, RunIdentity, StreamTabId } from '@shared/schemas';

/**
 * A live execution handle for tests.
 *
 * The run struct is assembled here and typed as the canonical
 * {@link ExecutionRun}, so a schema change breaks every fixture in one place.
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
}): AgentExecutionHandle {
  const streamId = input.childStreamId ?? input.parentStreamId;
  const run: ExecutionRun = {
    streamId,
    executionId: input.executionId as ExecutionId,
    identity: input.identity ?? { kind: 'agent', agent: input.agent },
    category: input.category ?? AgentCategory.ToolUse,
  };
  return new AgentExecutionHandle(run, input.parentStreamId, input.trace);
}

/** A registry with the canonical status-machine/event-hub pair for tests. */
export function testExecutionRegistry(): ExecutionRegistry {
  const events = new SessionEventHub();
  return new ExecutionRegistry({
    events,
    streamStatus: new StreamStatusMachine(events),
  });
}
