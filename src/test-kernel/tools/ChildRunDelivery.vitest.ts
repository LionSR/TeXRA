// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - shared
import type { ExecutionId, StreamTabId } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  writeResultMeta: vi.fn(),
  writeReport: vi.fn(),
  sendFollowUp: vi.fn(),
  wakeOrReleaseQueuedStream: vi.fn(),
}));

vi.mock('@agent/storage', () => ({
  getExecutionStore: vi.fn(() => ({
    writeReport: mocks.writeReport,
    writeResultMeta: mocks.writeResultMeta,
  })),
}));

vi.mock('@agent/followUp/ToolUseFollowUp', () => ({
  sendFollowUp: mocks.sendFollowUp,
  wakeOrReleaseQueuedStream: mocks.wakeOrReleaseQueuedStream,
}));

// Local imports - tools
import {
  deliverChildRunFollowUp,
  deliverTerminalChildRun,
  persistChildRunReport,
  persistChildRunResultMeta,
} from '@tools/childRunDelivery';

describe('child run delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists reports through the execution store', async () => {
    mocks.writeReport.mockResolvedValue(undefined);

    await expect(
      persistChildRunReport('exec-1' as ExecutionId, 'payload'),
    ).resolves.toEqual({ kind: 'persisted' });

    expect(mocks.writeReport).toHaveBeenCalledWith('payload');
  });

  it('returns the storage error when report persistence fails', async () => {
    const err = new Error('disk full');
    mocks.writeReport.mockRejectedValue(err);

    await expect(
      persistChildRunReport('exec-1' as ExecutionId, 'payload'),
    ).resolves.toEqual({ kind: 'failed', err });
  });

  it('persists result manifests through the execution store', async () => {
    const resultMeta = {
      agentName: 'review',
      outcome: 'completed',
      success: true,
      wallTimeMs: 1,
    } as const;
    mocks.writeResultMeta.mockResolvedValue(undefined);

    await expect(
      persistChildRunResultMeta('exec-1' as ExecutionId, resultMeta),
    ).resolves.toEqual({ kind: 'persisted' });

    expect(mocks.writeResultMeta).toHaveBeenCalledWith(resultMeta);
  });

  it('delivers a follow-up with the explicit owner session', async () => {
    const session = { tag: 'owner-session' };
    mocks.sendFollowUp.mockResolvedValue({ status: 'sent' });

    await expect(
      deliverChildRunFollowUp({
        targetStreamId: 'parent' as StreamTabId,
        followUp: { text: 'done', origin: 'subagent_result' },
        session: session as never,
      }),
    ).resolves.toEqual({ kind: 'delivered' });

    expect(mocks.sendFollowUp).toHaveBeenCalledWith(
      'parent',
      { text: 'done', origin: 'subagent_result' },
      undefined,
      undefined,
      session,
    );
    expect(mocks.wakeOrReleaseQueuedStream).not.toHaveBeenCalled();
  });

  it('wakes or releases force-opened parent queues with the same session', async () => {
    const session = { tag: 'owner-session' };
    const sendResult = { status: 'queued', reason: 'children_running' };
    mocks.sendFollowUp.mockResolvedValue(sendResult);
    mocks.wakeOrReleaseQueuedStream.mockResolvedValue(true);

    await expect(
      deliverChildRunFollowUp({
        targetStreamId: 'parent' as StreamTabId,
        followUp: { text: 'done', origin: 'subagent_result' },
        session: session as never,
        wake: true,
      }),
    ).resolves.toEqual({ kind: 'delivered' });

    expect(mocks.wakeOrReleaseQueuedStream).toHaveBeenCalledWith(
      'parent',
      sendResult,
      session,
    );
  });

  it('classifies missing and dropped parent streams', async () => {
    const session = { tag: 'owner-session' };
    mocks.sendFollowUp.mockResolvedValueOnce({
      status: 'no_session',
      streamStatus: 'completed',
    });

    await expect(
      deliverChildRunFollowUp({
        targetStreamId: 'parent' as StreamTabId,
        followUp: { text: 'done', origin: 'subagent_result' },
        session: session as never,
        wake: true,
      }),
    ).resolves.toEqual({
      kind: 'no_session',
      streamStatus: 'completed',
    });

    mocks.sendFollowUp.mockResolvedValueOnce({
      status: 'queued',
      reason: 'children_running',
    });
    mocks.wakeOrReleaseQueuedStream.mockResolvedValueOnce(false);

    await expect(
      deliverChildRunFollowUp({
        targetStreamId: 'parent' as StreamTabId,
        followUp: { text: 'done', origin: 'subagent_result' },
        session: session as never,
        wake: true,
      }),
    ).resolves.toEqual({ kind: 'dropped' });
  });

  it('writes the result manifest before waking the parent for terminal delivery', async () => {
    const session = { tag: 'owner-session' };
    const order: string[] = [];
    const gate = {
      beginDelivery: vi.fn(() => {
        order.push('begin');
        return true;
      }),
      completeDelivery: vi.fn(() => {
        order.push('complete');
      }),
      failDelivery: vi.fn(() => {
        order.push('fail');
      }),
    };
    mocks.writeResultMeta.mockImplementation(async () => {
      order.push('manifest');
    });
    mocks.writeReport.mockImplementation(async () => {
      order.push('report');
    });
    mocks.sendFollowUp.mockImplementation(async () => {
      order.push('send');
      return { status: 'queued', reason: 'children_running' };
    });
    mocks.wakeOrReleaseQueuedStream.mockImplementation(async () => {
      order.push('wake');
      return true;
    });

    await expect(
      deliverTerminalChildRun({
        executionId: 'exec-1' as ExecutionId,
        message: 'payload',
        resultMeta: {
          agentName: 'review',
          outcome: 'completed',
          success: true,
          wallTimeMs: 1,
        },
        targetStreamId: 'parent' as StreamTabId,
        session: session as never,
        gate,
      }),
    ).resolves.toMatchObject({
      kind: 'delivered',
      report: { kind: 'persisted' },
      resultMeta: { kind: 'persisted' },
    });

    expect(order.indexOf('manifest')).toBeLessThan(order.indexOf('send'));
    expect(order.indexOf('send')).toBeLessThan(order.indexOf('wake'));
    expect(gate.completeDelivery).toHaveBeenCalledOnce();
    expect(gate.failDelivery).not.toHaveBeenCalled();
  });

  it('persists terminal reports even when duplicate delivery is suppressed', async () => {
    const session = { tag: 'owner-session' };
    const gate = {
      beginDelivery: vi.fn(() => false),
      completeDelivery: vi.fn(),
      failDelivery: vi.fn(),
    };
    mocks.writeReport.mockResolvedValue(undefined);

    await expect(
      deliverTerminalChildRun({
        executionId: 'exec-1' as ExecutionId,
        message: 'payload',
        targetStreamId: 'parent' as StreamTabId,
        session: session as never,
        gate,
      }),
    ).resolves.toMatchObject({
      kind: 'duplicate',
      report: { kind: 'persisted' },
    });

    expect(mocks.writeReport).toHaveBeenCalledWith('payload');
    expect(mocks.sendFollowUp).not.toHaveBeenCalled();
    expect(gate.completeDelivery).not.toHaveBeenCalled();
    expect(gate.failDelivery).not.toHaveBeenCalled();
  });

  it('fails the terminal gate when delivery drops so a later attempt can retry', async () => {
    const session = { tag: 'owner-session' };
    const gate = {
      beginDelivery: vi.fn(() => true),
      completeDelivery: vi.fn(),
      failDelivery: vi.fn(),
    };
    mocks.writeReport.mockResolvedValue(undefined);
    mocks.sendFollowUp.mockResolvedValue({
      status: 'queued',
      reason: 'children_running',
    });
    mocks.wakeOrReleaseQueuedStream.mockResolvedValue(false);

    await expect(
      deliverTerminalChildRun({
        executionId: 'exec-1' as ExecutionId,
        message: 'payload',
        targetStreamId: 'parent' as StreamTabId,
        session: session as never,
        gate,
      }),
    ).resolves.toMatchObject({
      kind: 'dropped',
      report: { kind: 'persisted' },
    });

    expect(gate.failDelivery).toHaveBeenCalledOnce();
    expect(gate.completeDelivery).not.toHaveBeenCalled();
  });
});
