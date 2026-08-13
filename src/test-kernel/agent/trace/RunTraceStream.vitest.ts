import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  emitToolUseCard,
  endToolUseCard,
  startToolUseCard,
  type AgentTrace,
} from '@agent/trace';
import { MESSAGE_TYPES, type StreamLogEntry } from '@shared/schemas';
import { createRunTrace, StreamLogStore } from '@transcript';
import type { RunTraceFlushEntry } from '@transcript/runTrace';

function streamEntries(store: StreamLogStore): StreamLogEntry[] {
  return store.get('stream')?.getRange(0) ?? [];
}

function openDeferredThinking(
  logger: AgentTrace,
): ReturnType<AgentTrace['openStream']> {
  return logger.openStream(MESSAGE_TYPES.THINKING, { deferStart: true });
}

/** Run against a fresh, test-local store. */
function withStore(
  run: (
    store: StreamLogStore,
    logger: AgentTrace,
    flushPending: () => void,
  ) => void,
): void {
  const store = StreamLogStore.ephemeral('test');
  const flushers = new Map<string, RunTraceFlushEntry>();
  const handle = createRunTrace('stream', store, flushers);
  run(store, handle.trace, () => {
    for (const entry of flushers.values()) entry.flush();
  });
}

describe('AgentTrace stream output', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces streaming text updates and flushes on finalize', () => {
    vi.useFakeTimers();

    withStore((store, logger, flushPending) => {
      const stream = logger.openStream(MESSAGE_TYPES.MODEL_RESPONSE);

      stream.append('a');
      let entries = streamEntries(store);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.text).toBe('a');

      stream.append('b');
      stream.append('c');
      entries = streamEntries(store);
      expect(entries[0]?.text).toBe('a');

      vi.advanceTimersByTime(49);
      entries = streamEntries(store);
      expect(entries[0]?.text).toBe('a');

      vi.advanceTimersByTime(1);
      entries = streamEntries(store);
      expect(entries[0]?.text).toBe('abc');

      stream.append('d');
      expect(streamEntries(store)[0]?.text).toBe('abc');

      expect(stream.finalize()).toBe('abcd');
      expect(streamEntries(store)[0]?.text).toBe('abcd');

      vi.runOnlyPendingTimers();
      expect(streamEntries(store)[0]?.text).toBe('abcd');
    });
  });

  it('drains pending stream updates for shutdown persistence', () => {
    vi.useFakeTimers();

    withStore((store, logger, flushPending) => {
      const stream = logger.openStream(MESSAGE_TYPES.MODEL_RESPONSE);

      stream.append('a');
      stream.append('b');
      expect(streamEntries(store)[0]?.text).toBe('a');

      flushPending();
      expect(streamEntries(store)[0]?.text).toBe('ab');
      expect(vi.getTimerCount()).toBe(0);

      expect(stream.finalize()).toBe('ab');
    });
  });

  it('materializes streams at stream start, before any delta', () => {
    withStore((store, logger) => {
      const thinking = logger.openStream(MESSAGE_TYPES.THINKING);

      // The running entry exists immediately — the CLI keys its "model is
      // thinking" indicator off it, and hidden reasoning may never emit a
      // first chunk.
      let entries = streamEntries(store);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.messageType).toBe(MESSAGE_TYPES.THINKING);
      expect(entries[0]?.text).toBe('');
      expect(entries[0]?.data).toEqual({ status: 'running' });

      thinking.finalize();
      entries = streamEntries(store);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.data).toEqual({ status: 'completed' });
    });
  });

  it('emits nothing for a deferred stream until the first chunk', () => {
    withStore((store, logger, flushPending) => {
      const thinking = openDeferredThinking(logger);

      expect(store.get('stream')).toBeUndefined();

      thinking.append('reasoning delta');
      flushPending();

      const entries = streamEntries(store);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.messageType).toBe(MESSAGE_TYPES.THINKING);
      expect(entries[0]?.text).toBe('reasoning delta');

      expect(thinking.finalize()).toBe('reasoning delta');
      expect(streamEntries(store)[0]?.data).toEqual({
        status: 'completed',
      });
    });
  });

  it('leaves no trace for a deferred stream finalized without content', () => {
    withStore((store, logger) => {
      const thinking = openDeferredThinking(logger);

      expect(thinking.finalize()).toBe('');
      expect(store.get('stream')).toBeUndefined();
    });
  });

  it('materializes a deferred stream finalized with reasoning text', () => {
    withStore((store, logger) => {
      const thinking = openDeferredThinking(logger);

      // Mirrors providers that only return reasoning in the final response.
      expect(thinking.finalize('final reasoning')).toBe('final reasoning');

      const entries = streamEntries(store);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.text).toBe('final reasoning');
      expect(entries[0]?.data).toEqual({ status: 'completed' });
    });
  });

  it('announces phase boundaries without content for phase-only streams', () => {
    withStore((store, logger) => {
      // Workflow runs hide the response text (it is extracted and logged
      // separately) but still announce that the response phase started.
      const output = logger.openStream(MESSAGE_TYPES.MODEL_RESPONSE, {
        deferStart: true,
        phaseOnly: true,
      });

      expect(store.get('stream')).toBeUndefined();

      output.append('hidden partial output');

      let entries = streamEntries(store);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.messageType).toBe(MESSAGE_TYPES.MODEL_RESPONSE);
      expect(entries[0]?.text).toBe('');
      expect(entries[0]?.data).toEqual({ status: 'running' });

      // finalize returns the locally buffered text but never publishes it.
      expect(output.finalize('full output')).toBe('full output');
      entries = streamEntries(store);
      expect(entries[0]?.text).toBe('');
      expect(entries[0]?.data).toEqual({ status: 'completed' });
    });
  });

  it('accumulates disabled progress streams without scheduled updates', () => {
    vi.useFakeTimers();

    withStore((store, logger) => {
      const stream = logger.openStream(MESSAGE_TYPES.MODEL_RESPONSE, {
        progressViewEnabled: false,
      });

      stream.append('a');
      stream.append('b');
      stream.append('c');

      expect(store.get('stream')).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      expect(stream.finalize()).toBe('abc');
      expect(store.get('stream')).toBeUndefined();
    });
  });
});

describe('tool-use card input redaction', () => {
  it('redacts set_api_key input from fast-tool transcript persistence', () => {
    withStore((store, logger) => {
      const rawInput = { provider: 'openai', key: 'sk-secret-value' };
      const ref = emitToolUseCard(logger, {
        toolName: 'set_api_key',
        input: rawInput,
        summary: 'Stored OpenAI API key',
        output: 'Stored API key for provider "openai".',
        status: 'completed',
      });

      const entries = streamEntries(store);
      const toolEntry = entries.find((e) => e.id === ref.logId);

      expect(toolEntry?.data).toMatchObject({
        toolName: 'set_api_key',
        input: { provider: 'openai', key: '[redacted]' },
        status: 'completed',
      });
      expect(JSON.stringify(toolEntry?.data)).not.toContain('sk-secret-value');
      expect(rawInput.key).toBe('sk-secret-value');
    });
  });
});

describe('tool-use card groupId resolution', () => {
  it('reuses the captured groupId when endToolUseCard is called with no explicit stage', async () => {
    const store = StreamLogStore.ephemeral('test');
    const logger = createRunTrace('stream', store).trace;
    const outer = logger.openStage('outer');
    const ref = await outer.within(async () =>
      startToolUseCard(logger, 'demoTool', { arg: 1 }),
    );

    expect(ref.groupId).toBeDefined();

    // Mirrors the deferred-tool path: caller passes the captured ref so
    // the end event lands under the same stage as the start.
    endToolUseCard(logger, ref, {
      toolName: 'demoTool',
      input: { arg: 1 },
      output: 'ok',
    });

    const entries = streamEntries(store);
    const toolEntry = entries.find((e) => e.id === ref.logId);
    expect(toolEntry?.groupId).toBe(ref.groupId);
  });
});

describe('per-trace stage scope (cross-trace isolation)', () => {
  it('a run stage opened on its own trace does not inherit an active stage from another trace', async () => {
    const store = StreamLogStore.ephemeral('test');

    // Orchestrator trace with an active "Task:" stage — mirrors a subagent
    // launched from inside a delegation tool's stage scope.
    const orchestrator = createRunTrace('orchestrator', store).trace;
    const taskStage = orchestrator.openStage('Task: orchestrator');

    // Subagent run on a SEPARATE trace/stream, opened *inside* the
    // orchestrator's stage scope. With a per-instance stage scope the
    // orchestrator's active stage cannot leak across traces, so the
    // subagent's run stage is a root on its own stream with no extra flag.
    // (A module-level shared scope would orphan it under the cross-trace id.)
    await taskStage.within(async () => {
      const subagent = createRunTrace('subagent', store).trace;
      subagent.openStage('Run: subagent');
    });

    const entries = store.get('subagent')?.getRange(0) ?? [];
    const runStage = entries.find((e) => e.text === 'Run: subagent');
    expect(runStage).toBeDefined();
    expect(runStage?.groupId).toBeUndefined();
  });
});
