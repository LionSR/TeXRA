import { describe, expect, it } from 'vitest';

import type { ResultEvent } from '@agent/trace';
import { terminalResultToast } from '@agent/runtime/terminalResultToast';
import { INSTRUCTION_ACTION } from '@shared/schemas';

function result(over: Partial<ResultEvent>): ResultEvent {
  return {
    type: 'result',
    outcome: 'failed',
    executionId: 'exec',
    streamId: 'stream',
    agentName: 'assistant',
    category: 'toolUse',
    isSubagent: false,
    ...over,
  };
}

describe('terminalResultToast (SDK Step 7d PR 7)', () => {
  it('maps missing-api-key to an actionable instruction', () => {
    const toast = terminalResultToast(
      result({ error: { kind: 'missing-api-key' } }),
    );
    expect(toast?.type).toBe('instruction');
    if (toast?.type !== 'instruction') throw new Error('expected instruction');
    expect(toast.payload.key).toBe('missingApiKey');
    expect(toast.payload.actions).toEqual([
      INSTRUCTION_ACTION.SET_API_KEY,
      INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE,
    ]);
  });

  it('maps disk-full and unexpected to error toasts carrying the message', () => {
    const diskFull = terminalResultToast(
      result({ error: { kind: 'disk-full', message: 'No space left' } }),
    );
    expect(diskFull).toEqual({
      type: 'error',
      payload: { message: 'No space left' },
    });

    const unexpected = terminalResultToast(
      result({ error: { kind: 'unexpected', message: 'Boom' } }),
    );
    expect(unexpected).toEqual({ type: 'error', payload: { message: 'Boom' } });
  });

  it('shows no toast for subagent runs, aborts, or success', () => {
    expect(
      terminalResultToast(
        result({ isSubagent: true, error: { kind: 'unexpected' } }),
      ),
    ).toBeNull();
    expect(
      terminalResultToast(
        result({ outcome: 'cancelled', error: { kind: 'abort' } }),
      ),
    ).toBeNull();
    expect(terminalResultToast(result({ outcome: 'completed' }))).toBeNull();
  });
});
