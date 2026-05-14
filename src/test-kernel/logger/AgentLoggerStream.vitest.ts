import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentLogger } from '@logger/AgentLogger';
import { StreamLogStore } from '@logger/StreamLogStore';
import { MESSAGE_TYPES } from '@shared/schemas';

describe('AgentLogger stream output', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces streaming text updates and flushes on finalize', () => {
    vi.useFakeTimers();

    const previousStore = AgentLogger.getStreamLogStore();
    const store = new StreamLogStore();
    AgentLogger.setStreamLogStore(store);

    try {
      const logger = new AgentLogger('stream', true);
      const stream = logger.createStream(MESSAGE_TYPES.MODEL_RESPONSE);

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
      AgentLogger.setStreamLogStore(previousStore);
    }
  });

  it('accumulates disabled progress streams without scheduled updates', () => {
    vi.useFakeTimers();

    const previousStore = AgentLogger.getStreamLogStore();
    const store = new StreamLogStore();
    AgentLogger.setStreamLogStore(store);

    try {
      const logger = new AgentLogger('stream', true);
      const stream = logger.createStream(MESSAGE_TYPES.MODEL_RESPONSE, {
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
      AgentLogger.setStreamLogStore(previousStore);
    }
  });
});
