import { describe, expect, it } from 'vitest';

import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';
import { subscribeGoalStateChanges } from '@tools/goal';

describe('subscribeGoalStateChanges', () => {
  it('delivers only goal changes from the supplied session', () => {
    const sessionA = new SessionHandle();
    const sessionB = new SessionHandle();
    const seen: unknown[] = [];
    const detach = subscribeGoalStateChanges(sessionA, (change) => {
      seen.push(change);
    });

    try {
      sessionB.events.emit({
        scope: 'session',
        event: {
          type: 'goalStateChanged',
          payload: { streamId: 'other-session' as StreamTabId },
        },
      });
      sessionA.events.emit({
        scope: 'session',
        event: {
          type: 'setActiveStream',
          payload: { streamId: 'same-session' as StreamTabId },
        },
      });
      sessionA.events.emit({
        scope: 'session',
        event: {
          type: 'goalStateChanged',
          payload: { streamId: 'same-session' as StreamTabId },
        },
      });

      expect(seen).toEqual([{ streamId: 'same-session' }]);
    } finally {
      detach();
      sessionA.dispose();
      sessionB.dispose();
    }
  });
});
