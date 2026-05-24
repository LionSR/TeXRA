import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getDefaultStreamLogStore,
  setDefaultStreamLogStore,
  StreamLogStore,
} from '@transcript';
import { endToolUseCard, startToolUseCard } from '@agent/trace';
import { createRunTrace, flushPendingRunTraces } from '@logger';
import { MESSAGE_TYPES } from '@shared/schemas';

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

describe('openStage root option', () => {
  it('forces a root stage even when an active stage is in scope', async () => {
    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);

    try {
      const logger = createRunTrace('stream').trace;
      const outer = logger.openStage('outer');
      await outer.within(async () => {
        // A child agent's session stage opened on its own trace must NOT
        // inherit the parent's active stage from the shared AsyncLocalStorage.
        logger.openStage('child session', { root: true });
      });

      const entries = store.get('stream')?.getRange(0) ?? [];
      const child = entries.find((e) => e.text === 'child session');
      expect(child).toBeDefined();
      expect(child?.groupId).toBeUndefined();
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });
});
