// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Test support imports
import { createTestSession } from '@test/support/sessionTestUtils';

import { describe, expect, it } from 'vitest';

import { createRecordingHost } from '@test/agent/progressTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';
import { GoalStore, subscribeGoalStateChanges } from '@tools/goal';

const STREAM_ID = 'stream:goal-state-subscription' as StreamTabId;

describe('subscribeGoalStateChanges', () => {
  setupPlatform();

  it('delivers only goal changes from the supplied session', () => {
    const sessionA = createTestSession();
    const sessionB = createTestSession();
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

  it('routes start, status, and edit notifications through the current run session only', async () => {
    const runSession = createTestSession();
    const otherSession = createTestSession();
    const seenRun: unknown[] = [];
    const seenOther: unknown[] = [];
    const seenDefault: unknown[] = [];
    const detachRun = subscribeGoalStateChanges(runSession, (change) => {
      seenRun.push(change);
    });
    const detachOther = subscribeGoalStateChanges(otherSession, (change) => {
      seenOther.push(change);
    });
    const detachDefault = subscribeGoalStateChanges(
      defaultSession(),
      (change) => {
        seenDefault.push(change);
      },
    );

    try {
      await withRunContext(
        createRunContext({
          runtimeHost: createRecordingHost().host,
          session: runSession,
        }),
        async () => {
          await GoalStore.start(STREAM_ID, 'prove the estimate');
          await GoalStore.setStatus(STREAM_ID, 'paused');
          await GoalStore.editObjective(STREAM_ID, 'prove the sharp estimate');
        },
      );

      expect(seenRun).toEqual([
        { streamId: STREAM_ID },
        { streamId: STREAM_ID },
        { streamId: STREAM_ID },
      ]);
      expect(seenOther).toEqual([]);
      expect(seenDefault).toEqual([]);
    } finally {
      detachRun();
      detachOther();
      detachDefault();
      runSession.dispose();
      otherSession.dispose();
    }
  });
});
