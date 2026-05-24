import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getDefaultStreamLogStore,
  setDefaultStreamLogStore,
  StreamLogStore,
} from '@transcript';
import { createRunTrace, flushPendingRunTraces } from '@logger';
import { MESSAGE_TYPES, STREAM_LOG_ENTRY_TYPES } from '@shared/schemas';

describe('AgentLogger stream output', () => {
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

describe('AgentLogger groupId resolution', () => {
  it('keeps GROUP_START as a root group even when an active stage exists', async () => {
    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);

    try {
      const logger = createRunTrace('stream').trace;
      const outer = logger.openStage('outer');
      await outer.within(async () => {
        // Sanity: a plain log line emitted from inside the stage nests under it.
        logger.info('inside outer');
        // Calling startGroup() with no explicit parent must create a ROOT
        // group, not nest under the active stage.
        logger.startGroup('detached');
      });

      const entries = store.get('stream')?.getRange(0) ?? [];
      const detached = entries.find(
        (e) =>
          e.type === STREAM_LOG_ENTRY_TYPES.GROUP_START &&
          e.text === 'detached',
      );
      expect(detached).toBeDefined();
      expect(detached?.groupId).toBeUndefined();

      const inside = entries.find((e) => e.text === 'inside outer');
      expect(inside?.groupId).toBeDefined();
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });

  it('does not clobber a tool-use entry groupId when updateToolUse is called with undefined', async () => {
    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);

    try {
      const logger = createRunTrace('stream').trace;
      const outer = logger.openStage('outer');
      const { logId, groupId: createdGroupId } = await outer.within(async () =>
        logger.logToolUseStart('demoTool', { arg: 1 }),
      );

      expect(createdGroupId).toBeDefined();

      // Mirrors the deferred-tool path: caller never copied the resolved
      // groupId back into its ref, so it passes undefined on update.
      logger.updateToolUse(
        logId,
        { toolName: 'demoTool', input: { arg: 1 }, output: 'ok' },
        undefined,
      );

      const entries = store.get('stream')?.getRange(0) ?? [];
      const toolEntry = entries.find((e) => e.id === logId);
      expect(toolEntry?.groupId).toBe(createdGroupId);
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });
});
