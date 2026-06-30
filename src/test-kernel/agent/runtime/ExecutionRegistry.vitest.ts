// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import {
  AgentExecutionHandle,
  ExecutionRegistry,
  ProcessExecutionHandle,
  type LiveToolUseFlowContext,
} from '@agent/runtime/executionRegistry';
import { InterruptRegistry } from '@agent/runtime/InterruptRegistry';
import { ProcessOutputPoller } from '@agent/runtime/ProcessOutputPoller';
import { StreamStatusRegistry } from '@agent/runtime/StreamStatusService';
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

describe('executionRegistry', () => {
  it('owns process-output poller teardown', () => {
    const explicit = createRecordingHost();
    const processOutput = new ProcessOutputPoller();
    const dispose = vi.spyOn(processOutput, 'dispose');
    const flush = vi.spyOn(processOutput, 'flush');
    const registry = new ExecutionRegistry({ processOutput });
    const handle = new ProcessExecutionHandle(
      'exec-process-output-dispose-test',
      'stream-process-output-dispose-test' as StreamTabId,
      'bash',
      () => true,
      explicit.host,
    );

    registry.track(handle);
    registry.dispose();

    expect(dispose).toHaveBeenCalledOnce();
    expect(flush).not.toHaveBeenCalled();
  });

  it('uses its interrupt registry when terminating agent handles', () => {
    const explicit = createRecordingHost();
    const interrupts = new InterruptRegistry();
    const streamStatus = new StreamStatusRegistry();
    const registry = new ExecutionRegistry({ interrupts, streamStatus });
    const executionId = 'exec-injected-interrupt-test';
    const parentStreamId = 'parent-injected-interrupt-test' as StreamTabId;
    const childStreamId = 'child-injected-interrupt-test' as StreamTabId;
    const interrupt = vi.fn();

    try {
      interrupts.register(childStreamId, { interrupt });
      const handle = new AgentExecutionHandle(
        executionId,
        parentStreamId,
        childStreamId,
        'test-subagent',
        'toolUse',
        explicit.host,
      );
      registry.track(handle);

      expect(registry.kill(executionId)).toBe(true);

      expect(interrupt).toHaveBeenCalledOnce();
      expect(streamStatus.get(childStreamId)).toBe(STREAM_STATUS.STOPPED);
    } finally {
      registry.dispose();
      interrupts.unregister(childStreamId);
    }
  });

  it('owns visible stream stop policy for root and children', () => {
    const explicit = createRecordingHost();
    const interrupts = new InterruptRegistry();
    const streamStatus = new StreamStatusRegistry();
    const registry = new ExecutionRegistry({ interrupts, streamStatus });
    const rootStreamId = 'root-stop-policy-test' as StreamTabId;
    const childStreamId = 'child-stop-policy-test' as StreamTabId;
    const rootInterrupt = vi.fn();
    const childInterrupt = vi.fn();

    try {
      interrupts.register(rootStreamId, { interrupt: rootInterrupt });
      interrupts.register(childStreamId, { interrupt: childInterrupt });
      registry.track(
        new AgentExecutionHandle(
          'exec-root-stop-policy-test',
          rootStreamId,
          rootStreamId,
          'test-root',
          'toolUse',
          explicit.host,
        ),
      );
      registry.track(
        new AgentExecutionHandle(
          'exec-child-stop-policy-test',
          rootStreamId,
          childStreamId,
          'test-subagent',
          'toolUse',
          explicit.host,
        ),
      );

      expect(
        registry.stopAgentStream(rootStreamId, {
          runtimeHost: explicit.host,
        }),
      ).toBe(true);

      expect(rootInterrupt).toHaveBeenCalledOnce();
      expect(childInterrupt).toHaveBeenCalledOnce();
      expect(streamStatus.get(rootStreamId)).toBe(STREAM_STATUS.STOPPED);
      expect(streamStatus.get(childStreamId)).toBe(STREAM_STATUS.STOPPED);
    } finally {
      registry.dispose();
    }
  });

  it('interrupts grandchildren when killing a subagent chain', () => {
    const explicit = createRecordingHost();
    const interrupts = new InterruptRegistry();
    const streamStatus = new StreamStatusRegistry();
    const registry = new ExecutionRegistry({ interrupts, streamStatus });
    const rootStreamId = 'root-cascade-test' as StreamTabId;
    const childStreamId = 'child-cascade-test' as StreamTabId;
    const grandchildStreamId = 'grandchild-cascade-test' as StreamTabId;
    const childInterrupt = vi.fn();
    const grandchildInterrupt = vi.fn();

    try {
      interrupts.register(childStreamId, { interrupt: childInterrupt });
      interrupts.register(grandchildStreamId, {
        interrupt: grandchildInterrupt,
      });
      registry.track(
        new AgentExecutionHandle(
          'exec-child-cascade-test',
          rootStreamId,
          childStreamId,
          'test-subagent',
          'toolUse',
          explicit.host,
        ),
      );
      registry.track(
        new AgentExecutionHandle(
          'exec-grandchild-cascade-test',
          childStreamId,
          grandchildStreamId,
          'test-grandchild',
          'toolUse',
          explicit.host,
        ),
      );

      expect(registry.kill('exec-child-cascade-test')).toBe(true);

      expect(childInterrupt).toHaveBeenCalledOnce();
      expect(grandchildInterrupt).toHaveBeenCalledOnce();
      expect(streamStatus.get(childStreamId)).toBe(STREAM_STATUS.STOPPED);
      expect(streamStatus.get(grandchildStreamId)).toBe(STREAM_STATUS.STOPPED);
    } finally {
      registry.dispose();
      interrupts.unregister(childStreamId);
      interrupts.unregister(grandchildStreamId);
    }
  });

  it('detaches descendants when killing with detached subagents', () => {
    const explicit = createRecordingHost();
    const interrupts = new InterruptRegistry();
    const streamStatus = new StreamStatusRegistry();
    const registry = new ExecutionRegistry({ interrupts, streamStatus });
    const rootStreamId = 'root-detach-kill-test' as StreamTabId;
    const childStreamId = 'child-detach-kill-test' as StreamTabId;
    const grandchildStreamId = 'grandchild-detach-kill-test' as StreamTabId;
    const childInterrupt = vi.fn();
    const grandchildInterrupt = vi.fn();

    try {
      interrupts.register(childStreamId, { interrupt: childInterrupt });
      interrupts.register(grandchildStreamId, {
        interrupt: grandchildInterrupt,
      });
      registry.track(
        new AgentExecutionHandle(
          'exec-child-detach-kill-test',
          rootStreamId,
          childStreamId,
          'test-subagent',
          'toolUse',
          explicit.host,
        ),
      );
      registry.track(
        new AgentExecutionHandle(
          'exec-grandchild-detach-kill-test',
          childStreamId,
          grandchildStreamId,
          'test-grandchild',
          'toolUse',
          explicit.host,
        ),
      );

      expect(
        registry.kill('exec-child-detach-kill-test', {
          detachActiveChildren: true,
        }),
      ).toBe(true);

      expect(childInterrupt).toHaveBeenCalledOnce();
      expect(grandchildInterrupt).not.toHaveBeenCalled();
      expect(streamStatus.get(childStreamId)).toBe(STREAM_STATUS.STOPPED);
      expect(streamStatus.get(grandchildStreamId)).toBeUndefined();
      expect(
        registry.getAgentHandleByStream(grandchildStreamId)?.parentStreamId,
      ).toBe(grandchildStreamId);
      expect(explicit.events).toContainEqual({
        event: 'setParentStream',
        payload: {
          childStreamId: grandchildStreamId,
          parentStreamId: null,
        },
      });
    } finally {
      registry.dispose();
      interrupts.unregister(childStreamId);
      interrupts.unregister(grandchildStreamId);
    }
  });

  it('detaches children when stopping a stream with detached subagents', () => {
    const explicit = createRecordingHost();
    const interrupts = new InterruptRegistry();
    const streamStatus = new StreamStatusRegistry();
    const registry = new ExecutionRegistry({ interrupts, streamStatus });
    const rootStreamId = 'root-detach-stop-policy-test' as StreamTabId;
    const childStreamId = 'child-detach-stop-policy-test' as StreamTabId;
    const grandchildStreamId =
      'grandchild-detach-stop-policy-test' as StreamTabId;
    const rootInterrupt = vi.fn();
    const childInterrupt = vi.fn();
    const grandchildInterrupt = vi.fn();

    try {
      interrupts.register(rootStreamId, { interrupt: rootInterrupt });
      interrupts.register(childStreamId, { interrupt: childInterrupt });
      interrupts.register(grandchildStreamId, {
        interrupt: grandchildInterrupt,
      });
      registry.track(
        new AgentExecutionHandle(
          'exec-root-detach-stop-policy-test',
          rootStreamId,
          rootStreamId,
          'test-root',
          'toolUse',
          explicit.host,
        ),
      );
      registry.track(
        new AgentExecutionHandle(
          'exec-child-detach-stop-policy-test',
          rootStreamId,
          childStreamId,
          'test-subagent',
          'toolUse',
          explicit.host,
        ),
      );
      registry.track(
        new AgentExecutionHandle(
          'exec-grandchild-detach-stop-policy-test',
          childStreamId,
          grandchildStreamId,
          'test-grandchild',
          'toolUse',
          explicit.host,
        ),
      );

      expect(
        registry.stopAgentStream(rootStreamId, {
          detachActiveChildren: true,
          runtimeHost: explicit.host,
        }),
      ).toBe(true);

      expect(rootInterrupt).toHaveBeenCalledOnce();
      expect(childInterrupt).not.toHaveBeenCalled();
      expect(grandchildInterrupt).not.toHaveBeenCalled();
      expect(registry.getActiveChildren(rootStreamId).subagents).toHaveLength(
        0,
      );
      expect(
        registry.getAgentHandleByStream(childStreamId)?.parentStreamId,
      ).toBe(childStreamId);
      expect(
        registry.getAgentHandleByStream(grandchildStreamId)?.parentStreamId,
      ).toBe(childStreamId);
      expect(registry.getActiveChildren(childStreamId).subagents).toEqual([
        expect.objectContaining({ childStreamId: grandchildStreamId }),
      ]);
      expect(streamStatus.get(rootStreamId)).toBe(STREAM_STATUS.STOPPED);
      expect(streamStatus.get(childStreamId)).toBeUndefined();
      expect(streamStatus.get(grandchildStreamId)).toBeUndefined();
      expect(explicit.events).toContainEqual({
        event: 'setParentStream',
        payload: {
          childStreamId,
          parentStreamId: null,
        },
      });
    } finally {
      registry.dispose();
    }
  });

  it('stops a registered stream before its execution handle is tracked', () => {
    const explicit = createRecordingHost();
    const interrupts = new InterruptRegistry();
    const streamStatus = new StreamStatusRegistry();
    const registry = new ExecutionRegistry({ interrupts, streamStatus });
    const streamId = 'untracked-stop-policy-test' as StreamTabId;
    const interrupt = vi.fn();

    try {
      interrupts.register(streamId, { interrupt });

      expect(
        registry.stopAgentStream(streamId, {
          runtimeHost: explicit.host,
        }),
      ).toBe(true);

      expect(interrupt).toHaveBeenCalledOnce();
      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.STOPPED);
    } finally {
      registry.dispose();
    }
  });

  it('reports agent status from its stream-status owner', () => {
    const explicit = createRecordingHost();
    const streamStatus = new StreamStatusRegistry();
    const registry = new ExecutionRegistry({ streamStatus });
    const parentStreamId = 'parent-owned-status-test' as StreamTabId;
    const childStreamId = 'child-owned-status-test' as StreamTabId;
    const executionId = 'exec-owned-status-test';

    try {
      streamStatus.set(childStreamId, STREAM_STATUS.WAITING, { emit: false });
      registry.track(
        new AgentExecutionHandle(
          executionId,
          parentStreamId,
          childStreamId,
          'test-subagent',
          'toolUse',
          explicit.host,
        ),
      );

      expect(registry.getActiveChildren(parentStreamId).subagents).toEqual([
        expect.objectContaining({
          executionId,
          status: STREAM_STATUS.WAITING,
        }),
      ]);
    } finally {
      registry.dispose();
    }
  });

  it('publishes initial status when tracking an agent execution', () => {
    const explicit = createRecordingHost();
    const streamStatus = new StreamStatusRegistry();
    const registry = new ExecutionRegistry({ streamStatus });
    const parentStreamId = 'parent-track-agent-status-test' as StreamTabId;
    const childStreamId = 'child-track-agent-status-test' as StreamTabId;
    const executionId = 'exec-track-agent-status-test';

    try {
      registry.trackAgentExecution(
        new AgentExecutionHandle(
          executionId,
          parentStreamId,
          childStreamId,
          'test-subagent',
          'toolUse',
          explicit.host,
        ),
        { status: STREAM_STATUS.RUNNING },
      );

      expect(streamStatus.get(childStreamId)).toBe(STREAM_STATUS.RUNNING);
      expect(registry.getActiveChildren(parentStreamId).subagents).toEqual([
        expect.objectContaining({
          executionId,
          status: STREAM_STATUS.RUNNING,
        }),
      ]);
    } finally {
      registry.dispose();
    }
  });

  it('updates live agent status without reviving stopped or stale handles', () => {
    const explicit = createRecordingHost();
    const streamStatus = new StreamStatusRegistry();
    const registry = new ExecutionRegistry({ streamStatus });
    const parentStreamId = 'parent-update-agent-status-test' as StreamTabId;
    const childStreamId = 'child-update-agent-status-test' as StreamTabId;
    const executionId = 'exec-update-agent-status-test';
    const handle = new AgentExecutionHandle(
      executionId,
      parentStreamId,
      childStreamId,
      'test-subagent',
      'toolUse',
      explicit.host,
    );

    try {
      registry.trackAgentExecution(handle, { status: STREAM_STATUS.RUNNING });

      expect(
        registry.updateAgentExecutionStatus(handle, STREAM_STATUS.WAITING),
      ).toBe(true);
      expect(streamStatus.get(childStreamId)).toBe(STREAM_STATUS.WAITING);

      streamStatus.set(childStreamId, STREAM_STATUS.STOPPED, { emit: false });
      expect(
        registry.updateAgentExecutionStatus(handle, STREAM_STATUS.RUNNING),
      ).toBe(false);
      expect(streamStatus.get(childStreamId)).toBe(STREAM_STATUS.STOPPED);

      registry.untrack(executionId);
      streamStatus.set(childStreamId, STREAM_STATUS.WAITING, { emit: false });
      expect(
        registry.updateAgentExecutionStatus(handle, STREAM_STATUS.RUNNING),
      ).toBe(false);
      expect(streamStatus.get(childStreamId)).toBe(STREAM_STATUS.WAITING);
    } finally {
      registry.dispose();
    }
  });

  it('finishes agent executions without overwriting explicit stops', () => {
    const explicit = createRecordingHost();
    const streamStatus = new StreamStatusRegistry();
    const registry = new ExecutionRegistry({ streamStatus });
    const parentStreamId = 'parent-finish-agent-status-test' as StreamTabId;
    const childStreamId = 'child-finish-agent-status-test' as StreamTabId;
    const executionId = 'exec-finish-agent-status-test';
    const handle = new AgentExecutionHandle(
      executionId,
      parentStreamId,
      childStreamId,
      'test-subagent',
      'toolUse',
      explicit.host,
    );

    try {
      registry.track(handle);
      streamStatus.set(childStreamId, STREAM_STATUS.STOPPED, { emit: false });

      registry.finishAgentExecution(handle, {
        status: STREAM_STATUS.READY,
      });

      expect(streamStatus.get(childStreamId)).toBe(STREAM_STATUS.STOPPED);
      expect(registry.getHandle(executionId)).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('can finish an agent execution from its handle after untracking', () => {
    const explicit = createRecordingHost();
    const streamStatus = new StreamStatusRegistry();
    const registry = new ExecutionRegistry({ streamStatus });
    const parentStreamId = 'parent-finish-untracked-agent-test' as StreamTabId;
    const childStreamId = 'child-finish-untracked-agent-test' as StreamTabId;
    const executionId = 'exec-finish-untracked-agent-test';
    const handle = new AgentExecutionHandle(
      executionId,
      parentStreamId,
      childStreamId,
      'test-subagent',
      'toolUse',
      explicit.host,
    );

    try {
      registry.trackAgentExecution(handle, { status: STREAM_STATUS.RUNNING });
      registry.untrack(executionId);
      const activeUpdateCount = explicit.events.filter(
        (event) => event.event === 'updateActiveSubagents',
      ).length;

      registry.finishAgentExecution(handle, {
        status: STREAM_STATUS.ERROR,
      });

      expect(streamStatus.get(childStreamId)).toBe(STREAM_STATUS.ERROR);
      expect(
        explicit.events.filter(
          (event) => event.event === 'updateActiveSubagents',
        ),
      ).toHaveLength(activeUpdateCount);
      expect(registry.getHandle(executionId)).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('requires a runtime host when detaching without a tracked root handle', () => {
    const registry = new ExecutionRegistry();
    const streamId = 'missing-host-detach-stop-policy-test' as StreamTabId;

    try {
      expect(() =>
        registry.stopAgentStream(streamId, {
          detachActiveChildren: true,
        }),
      ).toThrow('requires a runtimeHost');
    } finally {
      registry.dispose();
    }
  });

  it('publishes handle updates through the handle runtime host', () => {
    const explicit = createRecordingHost();
    const registry = new ExecutionRegistry();
    const executionId = 'exec-handle-runtime-host-test';
    const parentStreamId = 'parent-handle-runtime-host-test' as StreamTabId;
    const childStreamId = 'child-handle-runtime-host-test' as StreamTabId;

    try {
      const handle = new AgentExecutionHandle(
        executionId,
        parentStreamId,
        childStreamId,
        'test-subagent',
        'toolUse',
        explicit.host,
      );

      registry.track(handle);
      registry.untrack(executionId);

      expect(explicit.events.map((entry) => entry.event)).toEqual([
        'updateActiveSubagents',
        'setParentStream',
        'updateActiveSubagents',
      ]);
      expect(explicit.events[0].payload).toMatchObject({
        parentStreamId,
        children: [
          {
            executionId,
            agentName: 'test-subagent',
            childStreamId,
          },
        ],
      });
      expect(explicit.events[2].payload).toEqual({
        parentStreamId,
        children: [],
      });
    } finally {
      registry.dispose();
    }
  });

  it('clears live tool-use context while the handle remains tracked', () => {
    const explicit = createRecordingHost();
    const registry = new ExecutionRegistry();
    const executionId = 'exec-live-flow-context-test';
    const streamId = 'stream-live-flow-context-test' as StreamTabId;
    const context: LiveToolUseFlowContext = {
      session: {
        appendFollowUp: vi.fn(),
      },
      modelHandler: {
        supportsManualCompaction: true,
      },
      runtimeHost: explicit.host,
      requestImmediateCompaction: vi.fn(),
      modelSwitchDisabledReason: vi.fn(),
      switchModel: vi.fn(),
    };

    try {
      const handle = new AgentExecutionHandle(
        executionId,
        streamId,
        streamId,
        'test-tool-use',
        'toolUse',
        explicit.host,
      );

      handle.attachToolUseFlow(context);
      registry.track(handle);

      expect(registry.getToolUseFlowContext(streamId)).toBe(context);

      handle.detachToolUseFlow(context);

      expect(registry.getToolUseFlowContext(streamId)).toBeUndefined();
      expect(registry.getAgentHandleByStream(streamId)).toBe(handle);
    } finally {
      registry.dispose();
    }
  });

  it('owns manual compaction admission for active tool-use flows', () => {
    const explicit = createRecordingHost();
    const registry = new ExecutionRegistry();
    const streamId = 'stream-manual-compaction-test' as StreamTabId;
    const unsupportedStreamId =
      'stream-manual-compaction-unsupported-test' as StreamTabId;
    const requestImmediateCompaction = vi.fn();
    const context: LiveToolUseFlowContext = {
      session: {
        appendFollowUp: vi.fn(),
      },
      modelHandler: {
        supportsManualCompaction: true,
      },
      runtimeHost: explicit.host,
      requestImmediateCompaction,
      modelSwitchDisabledReason: vi.fn(),
      switchModel: vi.fn(),
    };
    const unsupportedContext: LiveToolUseFlowContext = {
      ...context,
      modelHandler: {
        supportsManualCompaction: false,
      },
      requestImmediateCompaction: vi.fn(),
    };

    try {
      expect(registry.requestManualCompaction(undefined)).toEqual({
        kind: 'no_active_tool_use',
      });
      expect(registry.requestManualCompaction(streamId)).toEqual({
        kind: 'no_active_tool_use',
        streamId,
      });

      const handle = new AgentExecutionHandle(
        'exec-manual-compaction-test',
        streamId,
        streamId,
        'test-tool-use',
        'toolUse',
        explicit.host,
      );
      handle.attachToolUseFlow(context);
      registry.track(handle);

      const unsupportedHandle = new AgentExecutionHandle(
        'exec-manual-compaction-unsupported-test',
        unsupportedStreamId,
        unsupportedStreamId,
        'test-tool-use',
        'toolUse',
        explicit.host,
      );
      unsupportedHandle.attachToolUseFlow(unsupportedContext);
      registry.track(unsupportedHandle);

      expect(registry.requestManualCompaction(unsupportedStreamId)).toEqual({
        kind: 'unsupported',
        streamId: unsupportedStreamId,
      });
      expect(
        unsupportedContext.requestImmediateCompaction,
      ).not.toHaveBeenCalled();

      expect(registry.requestManualCompaction(streamId)).toEqual({
        kind: 'requested',
        streamId,
        runtimeHost: explicit.host,
      });
      expect(requestImmediateCompaction).toHaveBeenCalledOnce();
    } finally {
      registry.dispose();
    }
  });

  it('owns tool-use follow-up admission from status, context, and children', () => {
    const explicit = createRecordingHost();
    const streamStatus = new StreamStatusRegistry();
    const registry = new ExecutionRegistry({ streamStatus });
    const activeStreamId = 'stream-follow-up-active-test' as StreamTabId;
    const resumingStreamId = 'stream-follow-up-resuming-test' as StreamTabId;
    const waitingStreamId = 'stream-follow-up-waiting-test' as StreamTabId;
    const stoppedStreamId = 'stream-follow-up-stopped-test' as StreamTabId;
    const parentStreamId = 'stream-follow-up-parent-test' as StreamTabId;
    const childStreamId = 'stream-follow-up-child-test' as StreamTabId;
    const context: LiveToolUseFlowContext = {
      session: {
        appendFollowUp: vi.fn(),
      },
      modelHandler: {
        supportsManualCompaction: true,
      },
      runtimeHost: explicit.host,
      requestImmediateCompaction: vi.fn(),
      modelSwitchDisabledReason: vi.fn(),
      switchModel: vi.fn(),
    };

    try {
      const activeHandle = new AgentExecutionHandle(
        'exec-follow-up-active-test',
        activeStreamId,
        activeStreamId,
        'test-tool-use',
        'toolUse',
        explicit.host,
      );
      activeHandle.attachToolUseFlow(context);
      registry.track(activeHandle);
      streamStatus.set(activeStreamId, STREAM_STATUS.RUNNING, {
        emit: false,
      });

      expect(registry.getToolUseFollowUpTarget(activeStreamId)).toEqual({
        kind: 'active',
        context,
      });

      streamStatus.set(resumingStreamId, STREAM_STATUS.RESUMING, {
        emit: false,
      });
      expect(registry.getToolUseFollowUpTarget(resumingStreamId)).toEqual({
        kind: 'queue',
        reason: 'resuming',
      });

      streamStatus.set(waitingStreamId, STREAM_STATUS.WAITING, {
        emit: false,
      });
      expect(registry.getToolUseFollowUpTarget(waitingStreamId)).toEqual({
        kind: 'queue',
        reason: 'waiting',
      });

      streamStatus.set(stoppedStreamId, STREAM_STATUS.STOPPED, {
        emit: false,
      });
      expect(registry.getToolUseFollowUpTarget(stoppedStreamId)).toEqual({
        kind: 'no_session',
        streamStatus: STREAM_STATUS.STOPPED,
      });

      streamStatus.set(parentStreamId, STREAM_STATUS.STOPPED, {
        emit: false,
      });
      registry.track(
        new AgentExecutionHandle(
          'exec-follow-up-child-test',
          parentStreamId,
          childStreamId,
          'test-subagent',
          'toolUse',
          explicit.host,
        ),
      );
      expect(registry.getToolUseFollowUpTarget(parentStreamId)).toEqual({
        kind: 'queue',
        reason: 'children_running',
      });
    } finally {
      registry.dispose();
    }
  });

  it('publishes detach updates through the caller runtime host', () => {
    const explicit = createRecordingHost();
    const registry = new ExecutionRegistry();
    const executionId = 'exec-detach-runtime-host-test';
    const parentStreamId = 'parent-detach-runtime-host-test' as StreamTabId;
    const childStreamId = 'child-detach-runtime-host-test' as StreamTabId;

    try {
      const handle = new AgentExecutionHandle(
        executionId,
        parentStreamId,
        childStreamId,
        'test-subagent',
        'toolUse',
        explicit.host,
      );

      registry.track(handle);
      registry.detachActiveChildren(parentStreamId, explicit.host);

      expect(explicit.events.map((entry) => entry.event)).toEqual([
        'updateActiveSubagents',
        'setParentStream',
        'setParentStream',
        'updateActiveSubagents',
      ]);
      expect(explicit.events[2].payload).toEqual({
        childStreamId,
        parentStreamId: null,
      });
      expect(explicit.events[3].payload).toEqual({
        parentStreamId,
        children: [],
      });
    } finally {
      registry.dispose();
    }
  });

  it('detaches its stream-status listener when disposed', () => {
    const explicit = createRecordingHost();
    const streamStatus = new StreamStatusRegistry();
    const registry = new ExecutionRegistry({ streamStatus });
    const executionId = 'exec-dispose-runtime-host-test';
    const parentStreamId = 'parent-dispose-runtime-host-test' as StreamTabId;
    const childStreamId = 'child-dispose-runtime-host-test' as StreamTabId;

    const handle = new AgentExecutionHandle(
      executionId,
      parentStreamId,
      childStreamId,
      'test-subagent',
      'toolUse',
      explicit.host,
    );

    registry.track(handle);
    registry.dispose();
    explicit.events.length = 0;

    streamStatus.set(childStreamId, STREAM_STATUS.WAITING, {
      runtimeHost: explicit.host,
    });

    expect(
      explicit.events.some((entry) => entry.event === 'updateActiveSubagents'),
    ).toBe(false);
  });
});
