// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - agent
import type { ResultMeta } from '@agent/storage';

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
  enqueueChildRunFollowUp,
  wakeChildRunFollowUp,
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
      producer: 'subagent',
      agentName: 'review',
      wallTimeMs: 1,
      result: {
        category: 'toolUse',
        outcome: 'completed',
        response: 'done',
        files: [],
        cost: 0,
      },
    } satisfies ResultMeta;
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

  // #8093: enqueue and wake are split so a caller can finalize its own child
  // between them, keeping the (potentially slow) wake off the critical path
  // that must observe the child as terminal.
  describe('enqueueChildRunFollowUp / wakeChildRunFollowUp split', () => {
    it('enqueueChildRunFollowUp only sends — it never calls the wake port', async () => {
      const session = { tag: 'owner-session' };
      mocks.sendFollowUp.mockResolvedValue({ status: 'sent' });

      await expect(
        enqueueChildRunFollowUp({
          targetStreamId: 'parent' as StreamTabId,
          followUp: { text: 'done', origin: 'subagent_result' },
          session: session as never,
        }),
      ).resolves.toEqual({
        kind: 'enqueued',
        sendResult: { status: 'sent' },
      });
      expect(mocks.wakeOrReleaseQueuedStream).not.toHaveBeenCalled();
    });

    it('enqueueChildRunFollowUp classifies a missing parent session without waking', async () => {
      const session = { tag: 'owner-session' };
      mocks.sendFollowUp.mockResolvedValue({
        status: 'no_session',
        streamStatus: 'completed',
      });

      await expect(
        enqueueChildRunFollowUp({
          targetStreamId: 'parent' as StreamTabId,
          followUp: { text: 'done', origin: 'subagent_result' },
          session: session as never,
        }),
      ).resolves.toEqual({ kind: 'no_session', streamStatus: 'completed' });
      expect(mocks.wakeOrReleaseQueuedStream).not.toHaveBeenCalled();
    });

    it('wakeChildRunFollowUp resolves a no_session enqueue result without calling the wake port', async () => {
      const session = { tag: 'owner-session' };

      await expect(
        wakeChildRunFollowUp(
          'parent' as StreamTabId,
          { kind: 'no_session', streamStatus: 'completed' },
          session as never,
        ),
      ).resolves.toEqual({ kind: 'no_session', streamStatus: 'completed' });
      expect(mocks.wakeOrReleaseQueuedStream).not.toHaveBeenCalled();
    });

    it('wakeChildRunFollowUp wakes (or releases) using the enqueue result it was handed', async () => {
      const session = { tag: 'owner-session' };
      const sendResult = { status: 'queued', reason: 'children_running' };
      mocks.wakeOrReleaseQueuedStream.mockResolvedValue(true);

      await expect(
        wakeChildRunFollowUp(
          'parent' as StreamTabId,
          { kind: 'enqueued', sendResult: sendResult as never },
          session as never,
        ),
      ).resolves.toEqual({ kind: 'delivered' });
      expect(mocks.wakeOrReleaseQueuedStream).toHaveBeenCalledWith(
        'parent',
        sendResult,
        session,
      );
    });

    it('the enqueue half settles before a slow wake half resolves', async () => {
      // Regression shape for #8093: a caller must be able to observe the
      // enqueue's completion (and act on it — e.g. finalize its own child)
      // strictly before the wake half, which can hang for as long as the
      // resumed parent's own turn takes.
      const session = { tag: 'owner-session' };
      mocks.sendFollowUp.mockResolvedValue({
        status: 'queued',
        reason: 'children_running',
      });
      let resolveWake: (() => void) | undefined;
      mocks.wakeOrReleaseQueuedStream.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            resolveWake = () => resolve(true);
          }),
      );

      const enqueueResult = await enqueueChildRunFollowUp({
        targetStreamId: 'parent' as StreamTabId,
        followUp: { text: 'done', origin: 'subagent_result' },
        session: session as never,
      });
      // Enqueue is fully settled — the wake port has not even been called
      // yet, proving the caller can act on this result (e.g. finalize)
      // before ever touching the wake step.
      expect(mocks.wakeOrReleaseQueuedStream).not.toHaveBeenCalled();

      let woke = false;
      const wakePromise = wakeChildRunFollowUp(
        'parent' as StreamTabId,
        enqueueResult,
        session as never,
      ).then((result) => {
        woke = true;
        return result;
      });
      await Promise.resolve();
      expect(woke).toBe(false);

      resolveWake?.();
      await expect(wakePromise).resolves.toEqual({ kind: 'delivered' });
      expect(woke).toBe(true);
    });
  });
});
