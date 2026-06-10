import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRunTrace,
  flushPendingRunTraces,
  getDefaultStreamLogStore,
  setDefaultStreamLogStore,
  StreamLogStore,
} from '@transcript';
import { endToolUseCard, startToolUseCard } from '@agent/trace';
import { MESSAGE_TYPES } from '@shared/schemas';

describe('AgentTrace stream output', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces streaming text updates and flushes on finalize', () => {
    vi.useFakeTimers();

    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);

    try {
      const logger = createRunTrace('stream').trace;
      const stream = logger.openStream(MESSAGE_TYPES.MODEL_RESPONSE);

      stream.append('a');
      let entries = store.get('stream')?.getRange(0) ?? [];
      expect(entries).toHaveLength(1);
      expect(entries[0]?.text).toBe('a');

      stream.append('b');
      stream.append('c');
      entries = store.get('stream')?.getRange(0) ?? [];
      expect(entries[0]?.text).toBe('a');

      vi.advanceTimersByTime(49);
      entries = store.get('stream')?.getRange(0) ?? [];
      expect(entries[0]?.text).toBe('a');

      vi.advanceTimersByTime(1);
      entries = store.get('stream')?.getRange(0) ?? [];
      expect(entries[0]?.text).toBe('abc');

      stream.append('d');
      expect((store.get('stream')?.getRange(0) ?? [])[0]?.text).toBe('abc');

      expect(stream.finalize()).toBe('abcd');
      expect((store.get('stream')?.getRange(0) ?? [])[0]?.text).toBe('abcd');

      vi.runOnlyPendingTimers();
      expect((store.get('stream')?.getRange(0) ?? [])[0]?.text).toBe('abcd');
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });

  it('drains pending stream updates for shutdown persistence', () => {
    vi.useFakeTimers();

    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);

    try {
      const logger = createRunTrace('stream').trace;
      const stream = logger.openStream(MESSAGE_TYPES.MODEL_RESPONSE);

      stream.append('a');
      stream.append('b');
      expect((store.get('stream')?.getRange(0) ?? [])[0]?.text).toBe('a');

      flushPendingRunTraces();
      expect((store.get('stream')?.getRange(0) ?? [])[0]?.text).toBe('ab');
      expect(vi.getTimerCount()).toBe(0);

      expect(stream.finalize()).toBe('ab');
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });

  it('materializes thinking streams at stream start, before any delta', () => {
    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);

    try {
      const logger = createRunTrace('stream').trace;
      const thinking = logger.openStream(MESSAGE_TYPES.THINKING);

      // The running entry exists immediately — the CLI keys its "model is
      // thinking" indicator off it, and hidden reasoning may never emit a
      // first chunk.
      let entries = store.get('stream')?.getRange(0) ?? [];
      expect(entries).toHaveLength(1);
      expect(entries[0]?.messageType).toBe(MESSAGE_TYPES.THINKING);
      expect(entries[0]?.text).toBe('');
      expect(entries[0]?.data).toEqual({ status: 'running' });

      thinking.finalize();
      entries = store.get('stream')?.getRange(0) ?? [];
      expect(entries).toHaveLength(1);
      expect(entries[0]?.data).toEqual({ status: 'completed' });
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });

  it('emits nothing for a deferred stream until the first chunk', () => {
    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);

    try {
      const logger = createRunTrace('stream').trace;
      const thinking = logger.openStream(MESSAGE_TYPES.THINKING, {
        deferStart: true,
      });

      expect(store.get('stream')).toBeUndefined();

      thinking.append('reasoning delta');
      flushPendingRunTraces();

      const entries = store.get('stream')?.getRange(0) ?? [];
      expect(entries).toHaveLength(1);
      expect(entries[0]?.messageType).toBe(MESSAGE_TYPES.THINKING);
      expect(entries[0]?.text).toBe('reasoning delta');

      expect(thinking.finalize()).toBe('reasoning delta');
      expect((store.get('stream')?.getRange(0) ?? [])[0]?.data).toEqual({
        status: 'completed',
      });
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });

  it('leaves no trace for a deferred stream finalized without content', () => {
    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);

    try {
      const logger = createRunTrace('stream').trace;
      const thinking = logger.openStream(MESSAGE_TYPES.THINKING, {
        deferStart: true,
      });

      expect(thinking.finalize()).toBe('');
      expect(store.get('stream')).toBeUndefined();
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });

  it('materializes a deferred stream finalized with reasoning text', () => {
    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);

    try {
      const logger = createRunTrace('stream').trace;
      const thinking = logger.openStream(MESSAGE_TYPES.THINKING, {
        deferStart: true,
      });

      // Mirrors providers that only return reasoning in the final response.
      expect(thinking.finalize('final reasoning')).toBe('final reasoning');

      const entries = store.get('stream')?.getRange(0) ?? [];
      expect(entries).toHaveLength(1);
      expect(entries[0]?.text).toBe('final reasoning');
      expect(entries[0]?.data).toEqual({ status: 'completed' });
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });

  it('accumulates disabled progress streams without scheduled updates', () => {
    vi.useFakeTimers();

    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);

    try {
      const logger = createRunTrace('stream').trace;
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
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });
});

describe('tool-use card groupId resolution', () => {
  it('reuses the captured groupId when endToolUseCard is called with no explicit stage', async () => {
    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);

    try {
      const logger = createRunTrace('stream').trace;
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

      const entries = store.get('stream')?.getRange(0) ?? [];
      const toolEntry = entries.find((e) => e.id === ref.logId);
      expect(toolEntry?.groupId).toBe(ref.groupId);
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });
});

describe('per-trace stage scope (cross-trace isolation)', () => {
  it('a run stage opened on its own trace does not inherit an active stage from another trace', async () => {
    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);

    try {
      // Orchestrator trace with an active "Task:" stage — mirrors a subagent
      // launched from inside a delegation tool's stage scope.
      const orchestrator = createRunTrace('orchestrator').trace;
      const taskStage = orchestrator.openStage('Task: orchestrator');

      // Subagent run on a SEPARATE trace/stream, opened *inside* the
      // orchestrator's stage scope. With a per-instance stage scope the
      // orchestrator's active stage cannot leak across traces, so the
      // subagent's run stage is a root on its own stream with no extra flag.
      // (A module-level shared scope would orphan it under the cross-trace id.)
      await taskStage.within(async () => {
        const subagent = createRunTrace('subagent').trace;
        subagent.openStage('Run: subagent');
      });

      const entries = store.get('subagent')?.getRange(0) ?? [];
      const runStage = entries.find((e) => e.text === 'Run: subagent');
      expect(runStage).toBeDefined();
      expect(runStage?.groupId).toBeUndefined();
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });
});
