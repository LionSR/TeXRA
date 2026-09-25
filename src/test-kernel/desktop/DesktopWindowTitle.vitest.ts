import { EventEmitter } from 'node:events';

import { Exit, Scope, SubscriptionRef } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import {
  getDesktopWindowTitle,
  installDesktopWindowTitle,
} from '@desktop/main/desktopWindowTitle';
import { RUN_PHASE, type RunId } from '@shared/schemas';
import {
  emptySessionView,
  type SessionView,
} from '@shared/session/sessionView';
import { testRuntime } from '@test/support/testProcessRuntime';

type Activity = 'idle' | 'running' | 'approval';

const runId = 'run-1' as RunId;

/** The fold's level for one activity: a run working, or one parked on a
 *  request this window can answer. */
function viewFor(activity: Activity): SessionView {
  const view = emptySessionView('paper');
  if (activity === 'idle') return view;
  const run = {
    id: runId,
    group: activity === 'running' ? 'running' : 'waiting',
    status: activity === 'running' ? RUN_PHASE.RUNNING : RUN_PHASE.WAITING,
    approval: activity === 'running' ? 'none' : 'own',
    readOnly: false,
  };
  return {
    ...view,
    runs: new Map([[runId, run as never]]),
    requests:
      activity === 'approval'
        ? [
            {
              runId,
              requestId: 'bash-1',
              payload: { kind: 'bash' } as never,
              thread: null,
            },
          ]
        : [],
  };
}

/** A session as the title reads it: the fold's level and nothing else. */
function createSession(activity: Activity = 'idle') {
  const view = testRuntime().runSync(
    SubscriptionRef.make<SessionView>(viewFor(activity)),
  );
  return {
    session: { view },
    setActivity(next: Activity) {
      testRuntime().runSync(SubscriptionRef.set(view, viewFor(next)));
    },
  };
}

function createWindow(initialTitle: string) {
  const webContents = new EventEmitter();
  let title = initialTitle;
  let destroyed = false;
  const setTitle = vi.fn((nextTitle: string) => {
    title = nextTitle;
  });
  return {
    window: {
      getTitle: () => title,
      isDestroyed: () => destroyed,
      setTitle,
      webContents: Object.assign(webContents, { isDestroyed: () => false }),
    },
    setTitle,
    webContents,
    destroy: () => {
      destroyed = true;
    },
  };
}

type TitleSession = Parameters<typeof installDesktopWindowTitle>[1];

function installTitle(
  window: ReturnType<typeof createWindow>['window'],
  session: TitleSession,
  projectName = 'geometry',
): () => void {
  const scope = Scope.makeUnsafe();
  testRuntime().runSync(
    installDesktopWindowTitle(
      window as unknown as Parameters<typeof installDesktopWindowTitle>[0],
      session,
      projectName,
      () => true,
    ).pipe(Scope.provide(scope)),
  );
  return () => {
    testRuntime().runFork(Scope.close(scope, Exit.void));
  };
}

/** The fold publishes on the runtime; one macrotask lets its drain land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('desktop process-session window title', () => {
  it('reads the session activity from the view, a decision first', () => {
    const { session, setActivity } = createSession();
    expect(getDesktopWindowTitle(session, undefined)).toBe('TeXRA');

    setActivity('running');
    expect(getDesktopWindowTitle(session, undefined)).toBe('Running TeXRA');

    setActivity('approval');
    expect(getDesktopWindowTitle(session, 'geometry')).toBe(
      'Approval needed TeXRA · geometry',
    );

    setActivity('idle');
    expect(getDesktopWindowTitle(session, undefined)).toBe('TeXRA');
  });

  it('does not write the native title after window destruction', async () => {
    const { session, setActivity } = createSession();
    const view = createWindow('TeXRA · geometry');
    const dispose = installTitle(view.window, session);
    try {
      view.destroy();
      setActivity('running');
      await settle();
      expect(view.setTitle).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});
