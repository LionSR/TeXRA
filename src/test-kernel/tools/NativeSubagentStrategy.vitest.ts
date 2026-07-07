// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - agent
import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';

// Local imports - shared
import type { ExecutionId, StreamTabId } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  deliverChildRunFollowUp: vi.fn(),
  persistChildRunReport: vi.fn(),
  readConfig: vi.fn(),
  resumeQueuedToolUseSnapshot: vi.fn(),
  retrieveSessionResumeData: vi.fn(),
  writeResultMeta: vi.fn(),
}));

vi.mock('@agent/storage', () => ({
  getExecutionStore: vi.fn(() => ({
    readConfig: mocks.readConfig,
    writeResultMeta: mocks.writeResultMeta,
  })),
}));

vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: mocks.retrieveSessionResumeData,
}));

vi.mock('@agent/runtime/resumeQueuedToolUse', () => ({
  resumeQueuedToolUseSnapshot: mocks.resumeQueuedToolUseSnapshot,
}));

vi.mock('@tools/childRunDelivery', () => ({
  deliverChildRunFollowUp: mocks.deliverChildRunFollowUp,
  persistChildRunReport: mocks.persistChildRunReport,
}));

import { SharedSubagentDeliveryRegistry } from '@tools/subagentDeliveryState';
import {
  getNativeSubagentStrategy,
  NativeSubagentStrategy,
} from '@tools/delegation/nativeSubagentStrategy';

describe('NativeSubagentStrategy', () => {
  const executionId = 'exec-1' as ExecutionId;
  const parentStreamId = 'parent-stream' as StreamTabId;
  const ownerSession = {
    tag: 'owner-session',
    executions: { addListener: vi.fn(() => vi.fn()) },
  } as never;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    SharedSubagentDeliveryRegistry.finish(executionId);
  });

  it('persists the result manifest before waking the parent', async () => {
    const order: string[] = [];
    mocks.writeResultMeta.mockImplementation(async () => {
      order.push('manifest');
    });
    mocks.deliverChildRunFollowUp.mockImplementation(async () => {
      order.push('wake');
      return { kind: 'delivered' };
    });
    mocks.persistChildRunReport.mockImplementation(async () => {
      order.push('report');
      return { kind: 'persisted' };
    });
    const strategy = new NativeSubagentStrategy({
      executionId,
      agentName: 'review',
      orchestratorStreamId: parentStreamId,
      parentSession: ownerSession,
      runtimeHost: { emit: vi.fn() },
      startedAt: 0,
      settleSubagentCost: vi.fn(),
    });

    await expect(
      strategy.persistAndDeliverTerminal('payload', {
        agentName: 'review',
        outcome: 'completed',
        success: true,
        wallTimeMs: 1,
      }),
    ).resolves.toBe(true);

    expect(order[0]).toBe('manifest');
    expect(order).toContain('wake');
    expect(order).toContain('report');
    expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledWith({
      targetStreamId: parentStreamId,
      followUp: { text: 'payload', origin: 'subagent_result' },
      session: ownerSession,
      wake: true,
    });
  });

  it('uses the captured run handle delivery target', async () => {
    const handleParent = 'handle-parent' as StreamTabId;
    const childStream = 'child-stream' as StreamTabId;
    mocks.persistChildRunReport.mockResolvedValue({ kind: 'persisted' });
    mocks.deliverChildRunFollowUp.mockResolvedValue({ kind: 'delivered' });
    const strategy = new NativeSubagentStrategy({
      executionId,
      agentName: 'review',
      orchestratorStreamId: parentStreamId,
      parentSession: ownerSession,
      runtimeHost: { emit: vi.fn() },
      startedAt: 0,
      settleSubagentCost: vi.fn(),
    });
    strategy.setRunHandle(
      new AgentExecutionHandle(
        executionId,
        handleParent,
        childStream,
        'review',
        'toolUse',
        {} as never,
      ),
    );

    await expect(strategy.persistAndDeliverTerminal('payload')).resolves.toBe(
      true,
    );

    expect(mocks.deliverChildRunFollowUp).toHaveBeenCalledWith({
      targetStreamId: handleParent,
      followUp: { text: 'payload', origin: 'subagent_result' },
      session: ownerSession,
      wake: true,
    });
  });

  it('suppresses delivery after the captured run handle is detached', async () => {
    const handleParent = 'handle-parent' as StreamTabId;
    const childStream = 'child-stream' as StreamTabId;
    mocks.persistChildRunReport.mockResolvedValue({ kind: 'persisted' });
    const strategy = new NativeSubagentStrategy({
      executionId,
      agentName: 'review',
      orchestratorStreamId: parentStreamId,
      parentSession: ownerSession,
      runtimeHost: { emit: vi.fn() },
      startedAt: 0,
      settleSubagentCost: vi.fn(),
    });
    const handle = new AgentExecutionHandle(
      executionId,
      handleParent,
      childStream,
      'review',
      'toolUse',
      {} as never,
    );
    strategy.setRunHandle(handle);
    handle.detach();

    await expect(strategy.persistAndDeliverTerminal('payload')).resolves.toBe(
      false,
    );

    expect(mocks.deliverChildRunFollowUp).not.toHaveBeenCalled();
    expect(mocks.persistChildRunReport).toHaveBeenCalledWith(
      executionId,
      'payload',
    );
  });

  it('resets the in-flight delivery gate when terminal delivery drops', async () => {
    mocks.writeResultMeta.mockResolvedValue(undefined);
    mocks.persistChildRunReport.mockResolvedValue({ kind: 'persisted' });
    mocks.deliverChildRunFollowUp
      .mockResolvedValueOnce({ kind: 'dropped' })
      .mockResolvedValueOnce({ kind: 'delivered' });
    const strategy = new NativeSubagentStrategy({
      executionId,
      agentName: 'review',
      orchestratorStreamId: parentStreamId,
      parentSession: ownerSession,
      runtimeHost: { emit: vi.fn() },
      startedAt: 0,
      settleSubagentCost: vi.fn(),
    });

    await expect(strategy.persistAndDeliverTerminal('first')).resolves.toBe(
      false,
    );
    await expect(strategy.persistAndDeliverTerminal('second')).resolves.toBe(
      true,
    );
  });

  it('resumes queued follow-ups with native delivery callbacks', async () => {
    const childStream = 'child-stream' as StreamTabId;
    const runtimeHost = { emit: vi.fn() };
    const config = { agentCategory: 'toolUse' };
    const snapshot = {
      agentConfig: config,
      executionId,
      messages: [],
      streamId: childStream,
    };
    mocks.readConfig.mockResolvedValue(config);
    mocks.retrieveSessionResumeData.mockResolvedValue({
      type: 'toolUse',
      snapshot,
    });
    mocks.resumeQueuedToolUseSnapshot.mockResolvedValue(true);

    const strategy = new NativeSubagentStrategy({
      executionId,
      agentName: 'review',
      orchestratorStreamId: parentStreamId,
      parentSession: ownerSession,
      runtimeHost,
      startedAt: 0,
      settleSubagentCost: vi.fn(),
    });
    strategy.setChildStreamId(childStream);

    await expect(
      strategy.wakeQueuedFollowUp(
        { status: 'queued', reason: 'waiting' },
        {
          approvalPromptsUnavailable: true,
          runtimeUnavailableTools: ['edit_file'],
        },
      ),
    ).resolves.toEqual({ kind: 'resumed' });

    expect(mocks.retrieveSessionResumeData).toHaveBeenCalledWith(
      childStream,
      executionId,
      config,
    );
    expect(mocks.resumeQueuedToolUseSnapshot).toHaveBeenCalledWith(
      childStream,
      snapshot,
      runtimeHost,
      expect.objectContaining({
        allowWaitingResult: true,
        approvalPromptsUnavailable: true,
        parentStreamId,
        runtimeUnavailableTools: ['edit_file'],
        session: ownerSession,
        onBeforeWaiting: expect.any(Function),
        onCompleted: expect.any(Function),
        onFollowUpConsumed: expect.any(Function),
        onProgress: expect.any(Function),
        onRun: expect.any(Function),
        onRunError: expect.any(Function),
      }),
    );
  });

  it('cleans up registry entries when the underlying execution is untracked while abandoned in WAITING', () => {
    let abandonListener: ((handle: unknown) => void) | undefined;
    const addListener = vi.fn((_id: string, cb: (handle: unknown) => void) => {
      abandonListener = cb;
      return vi.fn();
    });
    const abandonableSession = {
      tag: 'abandonable-session',
      executions: { addListener },
    } as never;

    const strategy = new NativeSubagentStrategy({
      executionId,
      agentName: 'review',
      orchestratorStreamId: parentStreamId,
      parentSession: abandonableSession,
      runtimeHost: { emit: vi.fn() },
      startedAt: 0,
      settleSubagentCost: vi.fn(),
    });

    expect(addListener).toHaveBeenCalledWith(executionId, expect.any(Function));
    expect(getNativeSubagentStrategy(executionId)).toBe(strategy);
    expect(SharedSubagentDeliveryRegistry.getActive(executionId)).toBeDefined();

    // A native subagent that suspends into WAITING and is never resumed and
    // never errors has no other terminal event to drive `finish()`. Simulate
    // the execution registry's abandonment signal (session teardown, or the
    // handle otherwise being untracked) firing instead.
    abandonListener?.(undefined);

    expect(getNativeSubagentStrategy(executionId)).toBeUndefined();
    expect(
      SharedSubagentDeliveryRegistry.getActive(executionId),
    ).toBeUndefined();
  });

  it('cleans up registry entries even when a resumed completion hook throws', async () => {
    const childStream = 'child-stream' as StreamTabId;
    const config = { agentCategory: 'toolUse' };
    const snapshot = {
      agentConfig: config,
      executionId,
      messages: [],
      streamId: childStream,
    };
    mocks.readConfig.mockResolvedValue(config);
    mocks.retrieveSessionResumeData.mockResolvedValue({
      type: 'toolUse',
      snapshot,
    });
    let capturedOnCompleted: ((result: unknown) => Promise<void>) | undefined;
    mocks.resumeQueuedToolUseSnapshot.mockImplementation(
      async (
        _streamId: unknown,
        _snapshot: unknown,
        _host: unknown,
        options: { onCompleted: (result: unknown) => Promise<void> },
      ) => {
        capturedOnCompleted = options.onCompleted;
        return true;
      },
    );

    const strategy = new NativeSubagentStrategy({
      executionId,
      agentName: 'review',
      orchestratorStreamId: parentStreamId,
      parentSession: ownerSession,
      runtimeHost: { emit: vi.fn() },
      startedAt: 0,
      // Throwing here simulates a completion hook (formatting/delivery)
      // failing mid-flight — the exact scenario `runFlowWithLifecycle` only
      // logs and swallows rather than propagating back to this strategy.
      settleSubagentCost: () => {
        throw new Error('settle boom');
      },
    });
    strategy.setChildStreamId(childStream);

    await strategy.wakeQueuedFollowUp(
      { status: 'queued', reason: 'waiting' },
      {},
    );
    expect(capturedOnCompleted).toBeDefined();

    await expect(
      capturedOnCompleted?.({ category: 'toolUse', outcome: 'completed' }),
    ).rejects.toThrow('settle boom');

    // Despite the throw, `finish()` must still run (moved into `finally`) so
    // a later `delegate_agent` call doesn't find stale delivery state for a
    // run that has already exited its lifecycle.
    expect(getNativeSubagentStrategy(executionId)).toBeUndefined();
    expect(
      SharedSubagentDeliveryRegistry.getActive(executionId),
    ).toBeUndefined();
  });
});
