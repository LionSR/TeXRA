// Local imports
import type { AgentTrace } from '@agent/trace';
import { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import {
  RUN_DESCRIPTOR_SCHEMA_VERSION,
  type RunDescriptor,
  type StreamTabId,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas/agent';

/**
 * A live execution handle for tests.
 *
 * The identity object is assembled here rather than through
 * `buildRunDescriptor`, whose parse rejects the readable non-hex execution ids
 * fixtures use (`exec-a`, `execution-lease`). It is still typed as the
 * canonical {@link RunDescriptor}, so a schema change breaks every fixture in
 * one place.
 */
export function testExecutionHandle(input: {
  executionId: string;
  parentStreamId: StreamTabId;
  /** Defaults to `parentStreamId`, i.e. a run that is its own parent. */
  childStreamId?: StreamTabId;
  agent: string;
  category?: AgentCategory;
  trace?: AgentTrace;
}): AgentExecutionHandle {
  const streamId = input.childStreamId ?? input.parentStreamId;
  const descriptor: RunDescriptor = {
    schemaVersion: RUN_DESCRIPTOR_SCHEMA_VERSION,
    streamId,
    executionId: input.executionId,
    agent: input.agent,
    category: input.category ?? AgentCategory.ToolUse,
    kind: 'agent',
    configRef: {
      kind: 'executionConfig',
      executionId: input.executionId,
      path: `executions/${input.executionId}/config.json`,
    },
  };
  return new AgentExecutionHandle(
    descriptor,
    input.parentStreamId,
    input.trace,
  );
}
