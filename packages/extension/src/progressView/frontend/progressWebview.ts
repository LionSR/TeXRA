/**
 * The progress webview's root wiring (PRD one-fold-three-renderers, 7.7, 8,
 * 9): the one session of this webview, opened through the shared session
 * surfaces, assigned to the `<progress-app>` element on every change, the
 * window's one message listener, and the three shell events forwarded to
 * the surfaces. The sidebar port also reports which state it shows, so the
 * view-title menus can differ between the New-task state and a
 * conversation.
 */
import { hostBridge } from '@shared/hostBridge';
import { resolveSelected } from '@shared/session/surface';
import { createWebviewStorage } from '@shared/state/PersistedState';
import { createTicker } from '@utils/core';

import { createSessionSurfaces } from './sessionSurfaces';
import type { ProgressApp } from './ProgressApp';

/**
 * Mount the shell on `app`. Returns the unmount: the window's listener, the
 * clock, and the sessions released, as leaving the page does; a host that
 * remounts (the trace viewer's scrubber) calls it and mounts a fresh element.
 */
export function mountProgressWebview(app: ProgressApp): () => void {
  const sessionKey = app.dataset.session;
  if (!sessionKey) {
    throw new Error('<progress-app> is missing its data-session key');
  }
  const sessions = createSessionSurfaces({
    storage: createWebviewStorage(hostBridge),
    hostRequestFailureOwner: 'surface',
  });
  // Every message the extension posts to this window is a session message;
  // one that is not is the host's defect.
  const receive = (event: MessageEvent): void => {
    if (!sessions.receive(event.data)) {
      console.warn('[progress] unrecognized host message', event.data);
    }
  };
  window.addEventListener('message', receive);
  sessions.sync([sessionKey]);
  const session = sessions.get(sessionKey);
  if (!session) throw new Error(`Session ${sessionKey} did not open`);

  app.addEventListener('runtime-request', (event) => {
    sessions.runtimeRequest(sessionKey, event.detail);
  });
  app.addEventListener('host-request', (event) => {
    sessions.hostRequest(sessionKey, event.detail);
  });
  app.addEventListener('surface-action', (event) => {
    sessions.act(sessionKey, event.detail);
  });
  app.addEventListener('composer-submit', () => {
    sessions.submit(sessionKey);
  });

  let reportedView: 'main' | 'progress' | null = null;
  const assign = (): void => {
    const view = session.view$.get();
    const surface = session.surface$.get();
    const host = session.host$.get();
    app.view = view;
    app.surface = surface;
    app.host = host;
    app.nowMs = Date.now();
    if (app.placement !== 'sidebar') return;
    const shown = resolveSelected(view, surface) === null ? 'main' : 'progress';
    if (shown === reportedView) return;
    reportedView = shown;
    sessions.hostRequest(sessionKey, { kind: 'setActiveView', view: shown });
  };
  const unsubscribe = sessions.onChange(assign);
  const clock = createTicker(1000, () => {
    app.nowMs = Date.now();
  });
  assign();

  const dispose = (): void => {
    window.removeEventListener('pagehide', dispose);
    window.removeEventListener('message', receive);
    clock.dispose();
    unsubscribe();
    sessions.dispose();
  };
  window.addEventListener('pagehide', dispose, { once: true });
  return dispose;
}
