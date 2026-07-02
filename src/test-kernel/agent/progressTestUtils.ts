// Local imports
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  createRunContext,
  withRunContext,
  type RunCoordinators,
} from '@agent/runtime/RunContext';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

export type RecordedProgressEvent = {
  event: keyof ProgressEventPayloads;
  payload: ProgressEventPayloads[keyof ProgressEventPayloads];
};

export function createRecordingHost(): {
  events: RecordedProgressEvent[];
  host: AgentRuntimeHost;
} {
  const events: RecordedProgressEvent[] = [];
  return {
    events,
    host: {
      emit: (event, payload) => events.push({ event, payload }),
    },
  };
}

/**
 * Run `fn` inside a launch `RunContext` carrying `runtimeHost`/`streamId`.
 *
 * Flow nodes read these from the ambient `RunContext` rather than the
 * services bag (DI cleanup Step 2) — production always runs them inside
 * `withExecutionRunContext`, which always projects a `launch` context. Tests
 * that call a node's `exec`/`post` directly need the same scope.
 */
export function withTestRunContext<T>(
  runtimeHost: AgentRuntimeHost,
  streamId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withRunContext(
    createRunContext({
      runtimeHost,
      streamId: streamId as StreamTabId,
      executionId: 'test-execution' as ExecutionId,
      coordinators: {} as RunCoordinators,
      modelSource: 'live',
      getModel: () => undefined,
      agentName: 'test-agent',
      session: {} as SessionHandle,
    }),
    fn,
  ) as Promise<T>;
}
