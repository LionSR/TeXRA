/**
 * The progress webview's root wiring (PRD one-fold-three-renderers, 7.7, 8,
 * 9): the one session of this webview, opened through the shared session
 * surfaces, assigned to the `<progress-app>` element on every change, the
 * window's one message listener, and the three shell events forwarded to
 * the surfaces. The sidebar port also reports which state it shows, so the
 * view-title menus can differ between the New-task state and a
 * conversation.
 */
import { resolveSelected } from '@shared/session/surface';

import { createSessionSurfaces } from './sessionSurfaces';
import { webviewStorage } from './webviewStorage';
import type { ProgressApp } from './ProgressApp';

export function mountProgressWebview(app: ProgressApp): void {
  const sessionKey = app.dataset.session;
  if (!sessionKey) {
    throw new Error('<progress-app> is missing its data-session key');
  }
  const sessions = createSessionSurfaces({ storage: webviewStorage });
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
  const clock = window.setInterval(() => {
    app.nowMs = Date.now();
  }, 1000);
  assign();

  window.addEventListener(
    'pagehide',
    () => {
      window.removeEventListener('message', receive);
      window.clearInterval(clock);
      unsubscribe();
      sessions.dispose();
    },
    { once: true },
  );
}
