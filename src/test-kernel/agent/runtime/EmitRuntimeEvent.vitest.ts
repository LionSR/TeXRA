// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - runtime
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import { emitRuntimeEvent } from '@agent/runtime/emitRuntimeEvent';
import type { StreamTabId } from '@shared/schemas';

import { attachSessionProgressEventProjectionForTest } from '../sessionProgressTestUtils';
import { createRecordingHost } from '../progressTestUtils';

const streamId = (s: string): StreamTabId => s as StreamTabId;

describe('emitRuntimeEvent (SDK Step 7d F-1 — one emit path)', () => {
  it('routes migrated facts to the default session instead of the process bus', () => {
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
    const detachProjection = attachSessionProgressEventProjectionForTest(
      session.events,
      run.host,
    );
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
      expect(run.events).toEqual([
        {
          event: 'updateQueuedFollowUps',
          payload: { streamId: 's:run' },
        },
      ]);
    } finally {
      detachProjection();
      session.dispose();
    }
  });

  it('rejects non-session events instead of falling back to the process bus', () => {
    expect(() => {
      // @ts-expect-error requestShowError is host interaction, not a session fact.
      emitRuntimeEvent('requestShowError', { message: 'run error' });
    }).toThrow(
      'emitRuntimeEvent only supports session facts; use the owning runtime host for requestShowError',
    );
  });

  it('rejects non-session events instead of using the active run host', () => {
    const run = createRecordingHost();
    withRunContext(createRunContext({ runtimeHost: run.host }), () => {
      expect(() => {
        // @ts-expect-error requestShowError is host interaction, not a session fact.
        emitRuntimeEvent('requestShowError', { message: 'run error' });
      }).toThrow(
        'emitRuntimeEvent only supports session facts; use the owning runtime host for requestShowError',
      );
    });
    expect(run.events).toEqual([]);
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
