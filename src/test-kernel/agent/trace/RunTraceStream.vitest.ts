import { describe, expect, it } from 'vitest';

import {
  endToolUseCard,
  startToolUseCard,
  TraceEmitter,
  type AgentTrace,
  type AgentEvent,
} from '@agent/trace';
import { MESSAGE_TYPES, type RunId } from '@shared/schemas';
import { createTestRunTrace } from '@test/support/sessionTestUtils';

function openDeferredThinking(
  logger: AgentTrace,
): ReturnType<AgentTrace['openRun']> {
  return logger.openRun(MESSAGE_TYPES.THINKING, { deferStart: true });
}

/** The stream lifecycle a trace emitted: its starts and ends. */
function streamFacts(
  events: readonly AgentEvent[],
): { type: string; kind?: string; finalText?: string }[] {
  const facts: { type: string; kind?: string; finalText?: string }[] = [];
  for (const event of events) {
    if (event.type === 'stream.start') {
      facts.push({ type: event.type, kind: event.kind });
    } else if (event.type === 'stream.end') {
      facts.push({ type: event.type, finalText: event.finalText });
    }
  }
  return facts;
}

/** Run against a fresh, test-local trace, recording what it emits. */
function withTrace(
  run: (events: AgentEvent[], logger: AgentTrace) => void,
): void {
  const events: AgentEvent[] = [];
  run(events, new TraceEmitter((event) => events.push(event)));
}

describe('AgentTrace stream output', () => {
  it('materializes runs at stream start, before any delta', () => {
    withTrace((events, logger) => {
      const thinking = logger.openRun(MESSAGE_TYPES.THINKING);

      // The running stream exists immediately: the CLI keys its "model is
      // thinking" indicator off it, and hidden reasoning may never emit a
      // first chunk.
      expect(streamFacts(events)).toEqual([
        { type: 'stream.start', kind: MESSAGE_TYPES.THINKING },
      ]);

      thinking.finalize();
      expect(streamFacts(events)).toEqual([
        { type: 'stream.start', kind: MESSAGE_TYPES.THINKING },
        { type: 'stream.end', finalText: '' },
      ]);
    });
  });

  it('emits nothing for a deferred stream until the first chunk', () => {
    withTrace((events, logger) => {
      const thinking = openDeferredThinking(logger);

      expect(events).toEqual([]);

      thinking.append('reasoning delta');

      expect(streamFacts(events)).toEqual([
        { type: 'stream.start', kind: MESSAGE_TYPES.THINKING },
      ]);

      expect(thinking.finalize()).toBe('reasoning delta');
      expect(events.at(-1)).toMatchObject({
        type: 'stream.end',
        id: thinking.id,
        finalText: 'reasoning delta',
      });
    });
  });

  it('leaves no trace for a deferred stream finalized without content', () => {
    withTrace((events, logger) => {
      const thinking = openDeferredThinking(logger);

      expect(thinking.finalize()).toBe('');
      expect(events).toEqual([]);
    });
  });

  it('materializes a deferred stream finalized with reasoning text', () => {
    withTrace((events, logger) => {
      const thinking = openDeferredThinking(logger);

      // Mirrors providers that only return reasoning in the final response.
      expect(thinking.finalize('final reasoning')).toBe('final reasoning');

      expect(streamFacts(events)).toEqual([
        { type: 'stream.start', kind: MESSAGE_TYPES.THINKING },
        { type: 'stream.end', finalText: 'final reasoning' },
      ]);
    });
  });
});

describe('tool-use card input redaction', () => {
  it('reuses the captured groupId when endToolUseCard is called with no explicit stage', () => {
    const runTrace = createTestRunTrace('stream' as RunId);
    const logger = runTrace.trace;
    const outer = logger.openStage('outer');
    const ref = startToolUseCard(logger, 'demoTool', { arg: 1 }, outer.id);

    expect(ref.groupId).toBeDefined();

    // Mirrors the deferred-tool path: caller passes the captured ref so
    // the end event lands under the same stage as the start.
    endToolUseCard(logger, ref, {
      toolName: 'demoTool',
      input: { arg: 1 },
      output: 'ok',
    });

    const toolRow = runTrace.rows().find((row) => row.id === ref.logId);
    expect(toolRow?.groupId).toBe(ref.groupId);
  });
});
