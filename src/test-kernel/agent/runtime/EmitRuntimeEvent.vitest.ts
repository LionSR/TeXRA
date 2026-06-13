// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - runtime
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import { emitRuntimeEvent } from '@agent/runtime/emitRuntimeEvent';
import { bus } from '@eventBus/ProgressEventBus';
import type { StreamTabId } from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

const streamId = (s: string): StreamTabId => s as StreamTabId;

describe('emitRuntimeEvent (SDK Step 7d F-1 — one emit path)', () => {
  it('falls back to the process bus with no session and no run context', () => {
    const seen: unknown[] = [];
    const off = bus.on('goalStateChanged', (p) => seen.push(p));
    try {
      emitRuntimeEvent('goalStateChanged', { streamId: streamId('s:bus') });
      expect(seen).toEqual([{ streamId: 's:bus' }]);
    } finally {
      off();
    }
  });

  it("emits through the active run's runtimeHost when inside a run context", () => {
    const run = createRecordingHost();
    const busSeen: unknown[] = [];
    const off = bus.on('goalStateChanged', (p) => busSeen.push(p));
    try {
      withRunContext(createRunContext({ runtimeHost: run.host }), () => {
        emitRuntimeEvent('goalStateChanged', { streamId: streamId('s:run') });
      });
      expect(run.events).toEqual([
        { event: 'goalStateChanged', payload: { streamId: 's:run' } },
      ]);
      // Not double-emitted onto the bus.
      expect(busSeen).toEqual([]);
    } finally {
      off();
    }
  });

  it('prefers an explicit session hostChannel over the run context and bus', () => {
    const channel = createRecordingHost();
    const run = createRecordingHost();
    const session = new SessionHandle({ hostChannel: channel.host });
    const busSeen: unknown[] = [];
    const off = bus.on('goalStateChanged', (p) => busSeen.push(p));
    try {
      withRunContext(createRunContext({ runtimeHost: run.host }), () => {
        emitRuntimeEvent(
          'goalStateChanged',
          { streamId: streamId('s:chan') },
          session,
        );
      });
      expect(channel.events).toEqual([
        { event: 'goalStateChanged', payload: { streamId: 's:chan' } },
      ]);
      expect(run.events).toEqual([]);
      expect(busSeen).toEqual([]);
    } finally {
      off();
      session.dispose();
    }
  });
});
