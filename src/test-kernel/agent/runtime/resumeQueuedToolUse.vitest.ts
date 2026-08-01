import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ITool } from '@agent/core/tools/ToolTypes';
import { resumeQueuedToolUseFromResumeData } from '@agent/runtime/resumeQueuedToolUse';
import type { StreamTabId } from '@shared/schemas';
import { RUN_OUTCOME } from '@shared/schemas';
import { createDeferred } from '@test/support/asyncTestUtils';
import { createTestSession } from '@test/support/sessionTestUtils';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';

const resumeToolUseFromResumeDataMock = vi.hoisted(() => vi.fn());
vi.mock('@agent/runtime/executeAgent', () => ({
  resumeToolUseFromResumeData: resumeToolUseFromResumeDataMock,
}));

const STREAM = 'stream:resume-ownership' as StreamTabId;
const completed = {
  category: 'toolUse' as const,
  outcome: RUN_OUTCOME.COMPLETED,
  executionId: 'exec:resume',
  streamId: STREAM,
  response: 'done',
  files: [],
  totalCostUsd: 0,
};

function snapshot() {
  return createToolUseResumeData({ streamId: STREAM });
}

function seedRecoverable(
  session: ReturnType<typeof createTestSession>,
  ...texts: string[]
): void {
  const flow = session.followUps.claimLive(STREAM, 'flow')!;
  for (const text of texts) session.followUps.queue(flow).enqueue({ text });
  session.followUps.release(flow, 'recoverable');
}

describe('resumeQueuedToolUseFromResumeData ownership', () => {
  beforeEach(() => {
    resumeToolUseFromResumeDataMock.mockReset();
    resumeToolUseFromResumeDataMock.mockImplementation(
      async (_resume: unknown, options: any) => {
        options.onFollowUpConsumed?.();
        return completed;
      },
    );
  });

  it('claims recovery before draining and preserves ordered raced input', async () => {
    const session = createTestSession();
    seedRecoverable(session, 'first');
    const tools = [
      { definition: { name: 'run_scoped' }, call: vi.fn() },
    ] as unknown as readonly ITool[];

    try {
      await expect(
        resumeQueuedToolUseFromResumeData(STREAM, snapshot(), {
          session,
          tools,
          onFollowUpQueueReady: () => {
            expect(
              session.followUps.submit(
                STREAM,
                { text: 'second' },
                'recoverable',
              ),
            ).toEqual({ kind: 'recovering' });
          },
          onError: vi.fn(),
        }),
      ).resolves.toBe(true);

      const options = resumeToolUseFromResumeDataMock.mock.calls[0]?.[1];
      expect(options.tools).toBe(tools);
      expect(options.drainedFollowUps.map((item: any) => item.text)).toEqual([
        'first',
        'second',
      ]);
    } finally {
      session.dispose();
    }
  });

  it('rejects a competing recovery consumer deterministically', async () => {
    const session = createTestSession();
    seedRecoverable(session, 'once');
    const barrier = createDeferred();
    resumeToolUseFromResumeDataMock.mockImplementationOnce(async () => {
      await barrier.promise;
      return completed;
    });

    try {
      const first = resumeQueuedToolUseFromResumeData(STREAM, snapshot(), {
        session,
        onError: vi.fn(),
      });
      await vi.waitFor(() =>
        expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce(),
      );
      await expect(
        resumeQueuedToolUseFromResumeData(STREAM, snapshot(), {
          session,
          onError: vi.fn(),
        }),
      ).resolves.toBe(false);
      barrier.resolve();
      await first;
      expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce();
    } finally {
      session.dispose();
    }
  });

  it('restores an unconsumed batch after resume failure', async () => {
    const session = createTestSession();
    seedRecoverable(session, 'keep me');
    resumeToolUseFromResumeDataMock.mockRejectedValueOnce(new Error('failed'));

    try {
      await expect(
        resumeQueuedToolUseFromResumeData(STREAM, snapshot(), {
          session,
          onError: vi.fn(),
        }),
      ).resolves.toBe(false);
      expect(session.followUps.getAll(STREAM)).toEqual(['keep me']);
    } finally {
      session.dispose();
    }
  });

  it('replays a completed-child result that races a failed recovery', async () => {
    const session = createTestSession();
    seedRecoverable(session, 'original');
    let rejectResume!: (error: unknown) => void;
    const barrier = new Promise<never>((_resolve, reject) => {
      rejectResume = reject;
    });
    resumeToolUseFromResumeDataMock.mockReturnValueOnce(barrier);

    try {
      const resuming = resumeQueuedToolUseFromResumeData(STREAM, snapshot(), {
        session,
        onError: vi.fn(),
      });
      await vi.waitFor(() =>
        expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce(),
      );

      expect(
        session.followUps.submit(
          STREAM,
          { text: 'completed child', origin: 'subagent_result' },
          'recoverable',
        ),
      ).toEqual({ kind: 'recovering' });
      rejectResume(new Error('resume failed'));

      await expect(resuming).resolves.toBe(false);
      expect(session.followUps.getAll(STREAM)).toEqual([
        'original',
        'completed child',
      ]);
    } finally {
      session.dispose();
    }
  });

  it('adopts the exact recovery generation claimed by submission', async () => {
    const session = createTestSession();
    const submission = session.followUps.submit(
      STREAM,
      { text: 'claimed' },
      'recoverable',
    );
    expect(submission.kind).toBe('recovery');
    if (submission.kind !== 'recovery') throw new Error('recovery not claimed');
    const recovery = submission.lease;

    try {
      await expect(
        resumeQueuedToolUseFromResumeData(STREAM, snapshot(), {
          session,
          recovery,
          onError: vi.fn(),
        }),
      ).resolves.toBe(true);
      expect(resumeToolUseFromResumeDataMock).toHaveBeenCalledOnce();
    } finally {
      session.dispose();
    }
  });
});
