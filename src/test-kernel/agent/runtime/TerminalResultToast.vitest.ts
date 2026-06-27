import { describe, expect, it, vi } from 'vitest';

import { TraceEmitter, type ResultEvent } from '@agent/trace';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { attachDefaultTerminalResultToast } from '@agent/runtime/terminalResultToast';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';

function resultEvent(overrides: Partial<ResultEvent> = {}): ResultEvent {
  return {
    type: 'result',
    outcome: 'failed',
    executionId: 'exec',
    streamId: 'stream',
    agentName: 'assistant',
    category: 'toolUse',
    isSubagent: false,
    error: { kind: 'unexpected', message: 'Boom' },
    ...overrides,
  };
}

describe('runtime terminal result toasts', () => {
  it('attaches terminal result presentation to the default runtime session', () => {
    const emit = vi.fn();
    const runtimeHost = { emit } as unknown as AgentRuntimeHost;
    const trace = new TraceEmitter();
    const detachTrace = defaultSession().attachRunTrace(trace);
    const detachToast = attachDefaultTerminalResultToast(runtimeHost);

    try {
      trace.emit(resultEvent());

      expect(emit).toHaveBeenCalledWith('requestShowError', {
        message: 'Boom',
      });
    } finally {
      detachToast();
      detachTrace();
    }
  });
});
