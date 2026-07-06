// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - agent
import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';

// Local imports - shared
import type { ExecutionId, StreamTabId } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  deliverChildRunFollowUp: vi.fn(),
  persistChildRunReport: vi.fn(),
  writeResultMeta: vi.fn(),
}));

vi.mock('@agent/storage', () => ({
  getExecutionStore: vi.fn(() => ({ writeResultMeta: mocks.writeResultMeta })),
}));

vi.mock('@tools/childRunDelivery', () => ({
  deliverChildRunFollowUp: mocks.deliverChildRunFollowUp,
  persistChildRunReport: mocks.persistChildRunReport,
}));

import { subagentDeliveryRegistry } from '@tools/subagentDeliveryState';
import { NativeSubagentStrategy } from '@tools/delegation/nativeSubagentStrategy';

describe('NativeSubagentStrategy', () => {
  const executionId = 'exec-1' as ExecutionId;
  const parentStreamId = 'parent-stream' as StreamTabId;
  const ownerSession = { tag: 'owner-session' } as never;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    subagentDeliveryRegistry.finish(executionId);
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
});
