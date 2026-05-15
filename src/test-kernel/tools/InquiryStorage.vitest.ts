/**
 * Vitests for the inquiry storage layer: open → answer round-trip,
 * dropped path, follow-up turn semantics, legacy manifest migration,
 * and listing filters.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFakePlatform } from '@test/support/FakePlatform';
import type { StreamTabId } from '@shared/schemas';
import {
  listOpenThreads,
  listOpenThreadsForStream,
  listRecentClosedThreads,
  listThreadsByStatus,
  markDropped,
  readExternalInquiryThread,
  recordAnswerForOpenTurn,
  recordOpenQuestion,
} from '@tools/inquiry/externalInquiryStorage';
import { ToolError } from '@tools/result';

import type { Platform } from '@platform/platform';

const STREAM_A = 'stream:a' as StreamTabId;
const STREAM_B = 'stream:b' as StreamTabId;

async function freshPlatform(): Promise<Platform> {
  const { initPlatform } = await import('@platform/platform');
  const p = createFakePlatform();
  initPlatform(p);
  return p;
}

describe('InquiryStorage', () => {
  beforeEach(async () => {
    await freshPlatform();
  });
  afterEach(() => {
    // Tests don't share state beyond the in-memory FakePlatform fs.
  });

  it('opens, answers, and resolves a thread end-to-end', async () => {
    const opened = await recordOpenQuestion({
      parentStreamId: STREAM_A,
      question: 'What is the Sobolev constant?',
    });

    expect(opened.manifest.status).toBe('open');
    expect(opened.manifest.parentStreamId).toBe(STREAM_A);
    expect(opened.manifest.turns).toHaveLength(1);

    const open = await listOpenThreads();
    expect(open).toHaveLength(1);
    expect(open[0].status).toBe('open');

    const answered = await recordAnswerForOpenTurn({
      threadId: opened.threadId,
      answer: 'C = (n(n-2))^{-1} * ω_n^{2/n}',
    });
    expect(answered).not.toBeNull();
    expect(answered!.manifest.status).toBe('answered');
    expect(answered!.turn.answer).toBe('C = (n(n-2))^{-1} * ω_n^{2/n}');

    const stillOpen = await listOpenThreads();
    expect(stillOpen).toHaveLength(0);
  });

  it('rejects re-dispatch on an open thread', async () => {
    const opened = await recordOpenQuestion({
      parentStreamId: STREAM_A,
      question: 'Q1',
    });

    await expect(
      recordOpenQuestion({
        threadId: opened.threadId,
        parentStreamId: STREAM_A,
        question: 'Q2',
      }),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it('rejects ask on a dropped thread', async () => {
    const opened = await recordOpenQuestion({
      parentStreamId: STREAM_A,
      question: 'Q1',
    });
    await markDropped({ threadId: opened.threadId });

    await expect(
      recordOpenQuestion({
        threadId: opened.threadId,
        parentStreamId: STREAM_A,
        question: 'Follow-up',
      }),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it('allows ask follow-up on an answered thread; status flips back to open', async () => {
    const t = await recordOpenQuestion({
      parentStreamId: STREAM_A,
      question: 'Q1',
    });
    await recordAnswerForOpenTurn({ threadId: t.threadId, answer: 'A1' });

    const followUp = await recordOpenQuestion({
      threadId: t.threadId,
      parentStreamId: STREAM_A,
      question: 'Q2 (follow-up)',
    });

    expect(followUp.manifest.status).toBe('open');
    expect(followUp.manifest.turns).toHaveLength(2);
    expect(followUp.turn.question).toBe('Q2 (follow-up)');
  });

  it('updates parentStreamId on cross-stream follow-up', async () => {
    const t = await recordOpenQuestion({
      parentStreamId: STREAM_A,
      question: 'Q1',
    });
    await recordAnswerForOpenTurn({ threadId: t.threadId, answer: 'A1' });

    const fromB = await recordOpenQuestion({
      threadId: t.threadId,
      parentStreamId: STREAM_B,
      question: 'Q2 from B',
    });
    expect(fromB.manifest.parentStreamId).toBe(STREAM_B);

    const openOnA = await listOpenThreadsForStream(STREAM_A);
    const openOnB = await listOpenThreadsForStream(STREAM_B);
    expect(openOnA).toHaveLength(0);
    expect(openOnB).toHaveLength(1);
  });

  it('listThreadsByStatus filters by status and scope', async () => {
    const t1 = await recordOpenQuestion({
      parentStreamId: STREAM_A,
      question: 'Q1',
    });
    await recordAnswerForOpenTurn({ threadId: t1.threadId, answer: 'A1' });

    const t2 = await recordOpenQuestion({
      parentStreamId: STREAM_A,
      question: 'Q2',
    });
    void t2;

    const t3 = await recordOpenQuestion({
      parentStreamId: STREAM_B,
      question: 'Q3',
    });
    await markDropped({ threadId: t3.threadId });

    const openOnA = await listThreadsByStatus({
      status: 'open',
      scope: 'stream',
      streamId: STREAM_A,
    });
    expect(openOnA.map((t) => t.threadId)).toEqual([t2.threadId]);

    const allDropped = await listThreadsByStatus({
      status: 'dropped',
      scope: 'all',
    });
    expect(allDropped.map((t) => t.threadId)).toEqual([t3.threadId]);

    const closed = await listRecentClosedThreads({});
    expect(closed.map((t) => t.threadId).sort()).toEqual(
      [t1.threadId, t3.threadId].sort(),
    );
  });

  it('parses a legacy manifest (no status/parentStreamId) as answered with null parent', async () => {
    const platform = (await import('@platform/platform')).platform();
    const path = `ei_threads/ei_aabbccdd0011/manifest.json`;
    // Legacy manifest shape — pre-async storage.
    const legacy = {
      threadId: 'ei_aabbccdd0011',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-02T00:00:00.000Z',
      turns: [
        {
          turnIndex: 1,
          timestamp: '2025-01-01T00:00:00.000Z',
          question: 'Legacy Q',
          questionRelativePath: 't1/question.txt',
          answerRelativePath: 't1/answer.txt',
        },
      ],
    };
    await platform.fs.createDirectory(
      `${platform.storage.getGlobalStoragePath()}/ei_threads/ei_aabbccdd0011`,
    );
    await platform.fs.writeFile(
      `${platform.storage.getGlobalStoragePath()}/${path}`,
      Buffer.from(JSON.stringify(legacy), 'utf8'),
    );

    const manifest = await readExternalInquiryThread('ei_aabbccdd0011');
    expect(manifest).not.toBeNull();
    expect(manifest!.status).toBe('answered');
    expect(manifest!.parentStreamId).toBeNull();
  });
});
