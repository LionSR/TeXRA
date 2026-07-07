import { describe, expect, it } from 'vitest';

import type { AgentTrace } from '@agent/trace';
import { emitServerToolResult } from '@agent/modelHandlers/support/emitServerToolResult';
import type { WebSearchResult } from '@agent/modelHandlers/types/ServerToolTypes';

function captureTrace(): {
  trace: AgentTrace;
  events: Array<{ key: string; data?: unknown }>;
} {
  const events: Array<{ key: string; data?: unknown }> = [];
  return {
    events,
    trace: {
      domain(event: { key: string; data?: unknown }) {
        events.push(event);
      },
    } as AgentTrace,
  };
}

const searchResult: WebSearchResult = {
  query: 'texra release notes',
  results: [],
  provider: 'anthropic',
  callId: 'call_1',
  status: 'completed',
};

describe('emitServerToolResult', () => {
  it('logs a webSearch domain event when the progress view is enabled', () => {
    const { trace, events } = captureTrace();

    emitServerToolResult(trace, true, searchResult);

    expect(events).toEqual([{ key: 'webSearch', data: searchResult }]);
  });

  it('does nothing when the progress view is disabled', () => {
    const { trace, events } = captureTrace();

    emitServerToolResult(trace, false, searchResult);

    expect(events).toEqual([]);
  });
});
