// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - runtime
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import { emitRuntimeEvent } from '@agent/runtime/emitRuntimeEvent';
import { ProgressEventBus } from '@eventBus/ProgressEventBus';
import type { StreamTabId } from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

const streamId = (s: string): StreamTabId => s as StreamTabId;

describe('emitRuntimeEvent (SDK Step 7d F-1 — one emit path)', () => {
  it('routes migrated facts to the default session instead of the process bus', () => {
    const sessionSeen: unknown[] = [];
    const seen: unknown[] = [];
    const detachSession = defaultSession().events.subscribe(
      (event) => sessionSeen.push(event),
      { scope: 'session' },
    );
    const off = ProgressEventBus.on('goalStateChanged', (p) => seen.push(p));
    try {
      emitRuntimeEvent('goalStateChanged', { streamId: streamId('s:bus') });
      expect(sessionSeen).toEqual([
        {
          scope: 'session',
          event: {
            type: 'goalStateChanged',
            payload: { streamId: 's:bus' },
          },
        },
      ]);
      expect(seen).toEqual([]);
    } finally {
      detachSession();
      off();
    }
  });

  it("keeps non-migrated events on the active run's runtimeHost", () => {
    const run = createRecordingHost();
    const busSeen: unknown[] = [];
    const off = ProgressEventBus.on('requestShowError', (p) => busSeen.push(p));
    try {
      withRunContext(createRunContext({ runtimeHost: run.host }), () => {
        emitRuntimeEvent('requestShowError', { message: 'run error' });
      });
      expect(run.events).toEqual([
        { event: 'requestShowError', payload: { message: 'run error' } },
      ]);
      // Not double-emitted onto the bus.
      expect(busSeen).toEqual([]);
    } finally {
      off();
    }
  });

  it('prefers an explicit session event hub over the run context and bus for migrated facts', () => {
    const channel = createRecordingHost();
    const run = createRecordingHost();
    const session = new SessionHandle({ hostChannel: channel.host });
    const sessionSeen: unknown[] = [];
    const detachSession = session.events.subscribe(
      (event) => sessionSeen.push(event),
      { scope: 'session' },
    );
    const busSeen: unknown[] = [];
    const off = ProgressEventBus.on('goalStateChanged', (p) => busSeen.push(p));
    try {
      withRunContext(createRunContext({ runtimeHost: run.host }), () => {
        emitRuntimeEvent(
          'goalStateChanged',
          { streamId: streamId('s:chan') },
          session,
        );
      });
      expect(sessionSeen).toEqual([
        {
          scope: 'session',
          event: {
            type: 'goalStateChanged',
            payload: { streamId: 's:chan' },
          },
        },
      ]);
      expect(channel.events).toEqual([]);
      expect(run.events).toEqual([]);
      expect(busSeen).toEqual([]);
    } finally {
      detachSession();
      off();
      session.dispose();
    }
  });
});
