import { EventEmitter } from 'node:events';

import { SubscriptionRef } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import {
  getDesktopWindowTitle,
  installDesktopWindowTitle,
} from '@desktop/main/desktopWindowTitle';
import { effectRuntime } from '@platform/processRuntime';
import { formatSessionTitle, NATIVE_WINDOW_TITLE } from '@shared/sessionTitle';
import {
  emptySessionView,
  type SessionView,
} from '@shared/session/sessionView';

/** A session as the title reads it: the fold's level and nothing else. */
function createSession(rollup: Partial<SessionView['rollup']> = {}) {
  const view = effectRuntime().runSync(
    SubscriptionRef.make<SessionView>({
      ...emptySessionView('paper'),
      rollup: { running: 0, waiting: 0, interrupted: 0, ...rollup },
    }),
  );
  return {
    session: { view },
    setRollup(next: Partial<SessionView['rollup']>) {
      effectRuntime().runSync(
        SubscriptionRef.update(view, (current) => ({
          ...current,
          rollup: { ...current.rollup, ...next },
        })),
      );
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
  workspacePath = '/work/geometry',
): () => void {
  return installDesktopWindowTitle(
    window as unknown as Parameters<typeof installDesktopWindowTitle>[0],
    session,
    workspacePath,
  );
}

/** The fold publishes on the runtime; one macrotask lets its drain land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('desktop process-session window title', () => {
  it('reads the activity from the view rollup, a decision first', () => {
    const { session, setRollup } = createSession();
    expect(getDesktopWindowTitle(session, undefined)).toBe('TeXRA');

    setRollup({ running: 2 });
    expect(getDesktopWindowTitle(session, undefined)).toBe('Running TeXRA');

    setRollup({ waiting: 1 });
    expect(getDesktopWindowTitle(session, '/work/geometry')).toBe(
      'Approval needed TeXRA · geometry',
    );

    setRollup({ waiting: 0, running: 0 });
    expect(getDesktopWindowTitle(session, undefined)).toBe('TeXRA');
  });

  it('follows the view, prevents renderer replacement, deduplicates writes, and disposes', async () => {
    const { session, setRollup } = createSession();
    const view = createWindow('TeXRA · geometry');
    const dispose = installTitle(view.window, session);
    try {
      expect(view.setTitle).not.toHaveBeenCalled();

      const event = { preventDefault: vi.fn() };
      view.webContents.emit('page-title-updated', event, 'Renderer title');
      expect(event.preventDefault).toHaveBeenCalledOnce();

      setRollup({ running: 1 });
      await settle();
      expect(view.setTitle).toHaveBeenCalledWith('Running TeXRA · geometry');
      view.setTitle.mockClear();

      setRollup({ running: 1 });
      await settle();
      expect(view.setTitle).not.toHaveBeenCalled();

      dispose();
      expect(view.webContents.listenerCount('page-title-updated')).toBe(0);
      setRollup({ waiting: 1 });
      await settle();
      expect(view.setTitle).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('does not write the native title after window destruction', async () => {
    const { session, setRollup } = createSession();
    const view = createWindow('TeXRA · geometry');
    const dispose = installTitle(view.window, session);
    try {
      view.destroy();
      setRollup({ running: 1 });
      await settle();
      expect(view.setTitle).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});
