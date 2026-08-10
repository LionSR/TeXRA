import { describe, expect, it, vi } from 'vitest';

import { startCompactionActivity } from '@agent/trace';
import { logCompactionEvent } from '@agent/modelHandlers/support/compactionLogging';
import { spiedTrace } from '@test/support/spiedTrace';

type CompactionEvent = { key: string; text?: string; data?: unknown };

function logAndCapture(
  options: Omit<Parameters<typeof logCompactionEvent>[0], 'logger'>,
): CompactionEvent[] {
  const events: CompactionEvent[] = [];
  logCompactionEvent({
    logger: spiedTrace({ domain: (event) => events.push(event) }),
    ...options,
  });
  return events;
}

describe('logCompactionEvent', () => {
  it('marks client-side compaction token counts as estimated', () => {
    const events = logAndCapture({
      tokensBefore: 120_000,
      tokensAfter: 3_200,
      contextWindow: 200_000,
      details: 'Client-side compaction: 8 messages summarized',
      tokensAfterIsEstimate: true,
    });

    expect(events).toEqual([
      {
        key: 'contextManagement',
        text: 'Compacted conversation: 120,000 → ~3,200 tokens (97.3% reduction)',
        data: {
          action: 'compaction',
          tokensBefore: 120_000,
          tokensAfter: 3_200,
          contextWindow: 200_000,
          utilizationBefore: 60,
          utilizationAfter: 1.6,
          details: 'Client-side compaction: 8 messages summarized',
        },
      },
    ]);
  });

  it('logs measured compaction token counts without an estimate marker', () => {
    const events = logAndCapture({
      tokensBefore: 80_000,
      tokensAfter: 6_000,
      contextWindow: 100_000,
      details: 'OpenAI Responses API compaction: 4 items',
    });

    expect(events[0]?.text).toBe(
      'Compacted conversation: 80,000 → 6,000 tokens (92.5% reduction)',
    );
    expect(events[0]?.data).toMatchObject({
      tokensBefore: 80_000,
      tokensAfter: 6_000,
      utilizationBefore: 80,
      utilizationAfter: 6,
      details: 'OpenAI Responses API compaction: 4 items',
    });
  });
});

describe('startCompactionActivity', () => {
  it('correlates start and terminal markers and terminalizes once', () => {
    const trace = spiedTrace();
    const info = vi.mocked(trace.info);

    const activity = startCompactionActivity(trace);
    activity.finish('completed');
    activity.finish('failed');

    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls.map(([text]) => text)).toEqual([
      'Compacting conversation context',
      'Conversation context compaction completed',
    ]);
    expect(info.mock.calls.map(([, options]) => options?.data)).toEqual([
      {
        activity: 'context_compaction',
        operationId: activity.operationId,
        state: 'started',
      },
      {
        activity: 'context_compaction',
        operationId: activity.operationId,
        state: 'completed',
      },
    ]);
  });

  it.each(['failed', 'cancelled', 'skipped'] as const)(
    'emits the %s terminal outcome',
    (outcome) => {
      const trace = spiedTrace();
      const activity = startCompactionActivity(trace);
      activity.finish(outcome);

      expect(vi.mocked(trace.info).mock.calls.at(-1)?.[1]?.data).toMatchObject({
        operationId: activity.operationId,
        state: outcome,
      });
    },
  );
});
