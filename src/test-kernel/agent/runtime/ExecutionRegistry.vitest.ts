// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import {
  AgentExecutionHandle,
  ExecutionRegistry,
  type LiveToolUseFlowContext,
} from '@agent/runtime/executionRegistry';
import { InterruptRegistry } from '@agent/runtime/InterruptRegistry';
import { StreamStatusRegistry } from '@agent/runtime/StreamStatusService';
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

describe('executionRegistry', () => {
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

  it('detaches children when stopping a stream with detached subagents', () => {
    const explicit = createRecordingHost();
    const interrupts = new InterruptRegistry();
    const streamStatus = new StreamStatusRegistry();
    const registry = new ExecutionRegistry({ interrupts, streamStatus });
    const rootStreamId = 'root-detach-stop-policy-test' as StreamTabId;
    const childStreamId = 'child-detach-stop-policy-test' as StreamTabId;
    const rootInterrupt = vi.fn();
    const childInterrupt = vi.fn();

    try {
      interrupts.register(rootStreamId, { interrupt: rootInterrupt });
      interrupts.register(childStreamId, { interrupt: childInterrupt });
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

      expect(
        registry.stopAgentStream(rootStreamId, {
          detachActiveChildren: true,
          runtimeHost: explicit.host,
        }),
      ).toBe(true);

      expect(rootInterrupt).toHaveBeenCalledOnce();
      expect(childInterrupt).not.toHaveBeenCalled();
      expect(registry.getActiveChildren(rootStreamId).subagents).toHaveLength(
        0,
      );
      expect(
        registry.getAgentHandleByStream(childStreamId)?.parentStreamId,
      ).toBe(childStreamId);
      expect(streamStatus.get(rootStreamId)).toBe(STREAM_STATUS.STOPPED);
      expect(streamStatus.get(childStreamId)).toBeUndefined();
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
