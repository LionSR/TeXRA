import { describe, expect, it, vi } from 'vitest';

import { logCompactionActivity, type AgentTrace } from '@agent/trace';
import { logCompactionEvent } from '@agent/modelHandlers/support/compactionLogging';

function captureTrace(): {
  trace: AgentTrace;
  events: Array<{ key: string; text?: string; data?: unknown }>;
} {
  const events: Array<{ key: string; text?: string; data?: unknown }> = [];
  return {
    events,
    trace: {
      domain(event: { key: string; text?: string; data?: unknown }) {
        events.push(event);
      },
    } as AgentTrace,
  };
}

describe('logCompactionEvent', () => {
  it('marks client-side compaction token counts as estimated', () => {
    const { trace, events } = captureTrace();

    logCompactionEvent({
      logger: trace,
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
    const { trace, events } = captureTrace();

    logCompactionEvent({
      logger: trace,
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

describe('logCompactionActivity', () => {
  it('emits typed start and finish progress markers', () => {
    const info = vi.fn();
    const trace = { info } as unknown as AgentTrace;

    logCompactionActivity(trace, 'started');
    logCompactionActivity(trace, 'finished');

    expect(info.mock.calls).toEqual([
      [
        'Compacting conversation context',
        {
          messageType: 'contextCompactionActivity',
          data: {
            activity: 'context_compaction',
            state: 'started',
          },
        },
      ],
      [
        'Conversation context compaction finished',
        {
          messageType: 'contextCompactionActivity',
          data: {
            activity: 'context_compaction',
            state: 'finished',
          },
        },
      ],
    ]);
  });
});
