import { describe, expect, it, vi } from 'vitest';

import {
  AgentExecutionHandle,
  type LiveToolUseFlowContext,
} from '@agent/runtime/executionRegistry';
import {
  requestManualCompaction,
  type ManualCompactionRequestResult,
} from '@agent/runtime/manualCompaction';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';

function createRecordingHost(): AgentRuntimeHost {
  return {
    emit: vi.fn(),
  };
}

function compactableFlow(
  host: AgentRuntimeHost,
  supportsManualCompaction = true,
): LiveToolUseFlowContext {
  return {
    session: {
      appendFollowUp: vi.fn(),
    },
    modelHandler: {
      supportsManualCompaction,
    },
    runtimeHost: host,
    requestImmediateCompaction: vi.fn(),
    modelSwitchDisabledReason: vi.fn(),
    switchModel: vi.fn(),
  };
}

function trackToolUseFlow(
  session: SessionHandle,
  streamId: StreamTabId,
  flowContext: LiveToolUseFlowContext,
  host: AgentRuntimeHost,
): void {
  const handle = new AgentExecutionHandle(
    `exec-${streamId}`,
    streamId,
    streamId,
    'test-tool-use',
    'toolUse',
    host,
  );
  handle.attachToolUseFlow(flowContext);
  session.executions.track(handle);
}

function withSession(
  testBody: (session: SessionHandle) => ManualCompactionRequestResult,
): ManualCompactionRequestResult {
  const session = new SessionHandle();
  try {
    return testBody(session);
  } finally {
    session.dispose();
  }
}

describe('requestManualCompaction', () => {
  it('reports a missing active stream without touching runtime state', () => {
    const result = withSession((session) =>
      requestManualCompaction(undefined, session),
    );

    expect(result).toEqual({
      status: 'no_session',
      message: 'No active tool-use session found for context compaction.',
    });
  });

  it('reports a stale stream with no live tool-use flow', () => {
    const result = withSession((session) =>
      requestManualCompaction('stream-stale' as StreamTabId, session),
    );

    expect(result).toEqual({
      status: 'no_session',
      message: 'No active tool-use session found for context compaction.',
    });
  });

  it('reports models that cannot compact manually', () => {
    const streamId = 'stream-unsupported-compaction' as StreamTabId;
    const host = createRecordingHost();
    const flowContext = compactableFlow(host, false);

    const result = withSession((session) => {
      trackToolUseFlow(session, streamId, flowContext, host);
      return requestManualCompaction(streamId, session);
    });

    expect(result).toEqual({
      status: 'unsupported_model',
      message:
        'Manual context compaction is not available for the current model.',
    });
    expect(flowContext.requestImmediateCompaction).not.toHaveBeenCalled();
    expect(host.emit).not.toHaveBeenCalled();
  });

  it('requests compaction and emits a follow-up notification for a live tool-use flow', () => {
    const streamId = 'stream-request-compaction' as StreamTabId;
    const host = createRecordingHost();
    const flowContext = compactableFlow(host);

    const result = withSession((session) => {
      trackToolUseFlow(session, streamId, flowContext, host);
      return requestManualCompaction(streamId, session);
    });

    expect(result).toEqual({
      status: 'requested',
      message:
        'Context compaction requested. The agent will process it on the next model call.',
    });
    expect(flowContext.requestImmediateCompaction).toHaveBeenCalledOnce();
    expect(host.emit).toHaveBeenCalledExactlyOnceWith('followUpSent', {
      streamId,
      messages: [],
    });
  });
});
