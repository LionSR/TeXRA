// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - shared
import type { ExecutionId, StreamTabId } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  currentSession: vi.fn(),
  deliverChildRunFollowUp: vi.fn(),
  persistChildRunReport: vi.fn(),
  writeResultMeta: vi.fn(),
}));

vi.mock('@agent/runtime/SessionHandle', () => ({
  currentSession: mocks.currentSession,
}));

vi.mock('@agent/storage', () => ({
  getExecutionStore: vi.fn(() => ({ writeResultMeta: mocks.writeResultMeta })),
}));

vi.mock('@tools/childRunDelivery', () => ({
  deliverChildRunFollowUp: mocks.deliverChildRunFollowUp,
  persistChildRunReport: mocks.persistChildRunReport,
}));

// Local imports - tools
import { subagentDeliveryRegistry } from '@tools/subagentDeliveryState';
import { NativeSubagentStrategy } from '@tools/delegation/nativeSubagentStrategy';

describe('NativeSubagentStrategy', () => {
  const executionId = 'exec-1' as ExecutionId;
  const parentStreamId = 'parent-stream' as StreamTabId;
  const ownerSession = { tag: 'owner-session' } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentSession.mockReturnValue({
      executions: { getHandle: vi.fn(() => undefined) },
    });
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
