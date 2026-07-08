// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - runtime
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import { emitRuntimeEvent } from '@agent/runtime/emitRuntimeEvent';
import type { StreamTabId } from '@shared/schemas';

import { createRecordingHost, recordSessionEvents } from '../progressTestUtils';

const streamId = (s: string): StreamTabId => s as StreamTabId;

describe('emitRuntimeEvent (SDK Step 7d F-1 — one emit path)', () => {
  it('routes session facts to the default session', () => {
    const sessionSeen: unknown[] = [];
    const detachSession = defaultSession().events.subscribe(
      (event) => sessionSeen.push(event),
      { scope: 'session' },
    );
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
    } finally {
      detachSession();
    }
  });

  it("routes in-run facts through the active run's session", () => {
    const run = createRecordingHost();
    const session = new SessionHandle();
    const recorded = recordSessionEvents(session.events, { scope: 'session' });
    try {
      withRunContext(
        createRunContext({
          runtimeHost: run.host,
          session,
        }),
        () => {
          emitRuntimeEvent('updateQueuedFollowUps', {
            streamId: streamId('s:run'),
          });
        },
      );
      expect(recorded.events).toEqual([
        {
          scope: 'session',
          event: {
            type: 'updateQueuedFollowUps',
            payload: { streamId: 's:run' },
          },
        },
      ]);
    } finally {
      recorded.detach();
      session.dispose();
    }
  });

  it('prefers an explicit session event hub over the run context for session facts', () => {
    const channel = createRecordingHost();
    const run = createRecordingHost();
    const session = new SessionHandle({ hostChannel: channel.host });
    const sessionSeen: unknown[] = [];
    const detachSession = session.events.subscribe(
      (event) => sessionSeen.push(event),
      { scope: 'session' },
    );
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
    } finally {
      detachSession();
      session.dispose();
    }
  });
});
