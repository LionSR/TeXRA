/**
 * The progress webview's root wiring: the one session of this webview, opened through the shared session
 * surfaces, assigned to the `<progress-app>` element on every change, the
 * window's one message listener, and the shell's events sent to the
 * surfaces. The sidebar port also reports which state it shows, so the
 * view-title menus can differ between the New-task state and a
 * conversation.
 */
import { hostBridge } from '@texra/shared/hostBridge';
import { createWebviewStorage } from '@texra/shared/state/PersistedState';

import { createSessionSurfaces } from './sessionSurfaces';
import type { ProgressApp } from './ProgressApp';

/**
 * Mount the shell on `app`. Returns the unmount: the window's listener and
 * the sessions released, as leaving the page does; a host that remounts (the
 * trace viewer's scrubber) calls it and mounts a fresh element.
 */
export function mountProgressWebview(app: ProgressApp): () => void {
  const sessionKey = app.dataset.session;
  if (!sessionKey) {
    throw new Error('<progress-app> is missing its data-session key');
  }
  const sessions = createSessionSurfaces({
    storage: createWebviewStorage(hostBridge),
    post: (message) => hostBridge.postMessage(message),
  });
  // Every message the extension posts to this window is a session message;
  // one that is not is the host's defect, which `receive` reports.
  const receive = (event: MessageEvent): void => sessions.receive(event.data);
  window.addEventListener('message', receive);
  sessions.sync([sessionKey]);
  const session = sessions.get(sessionKey);
  if (!session) throw new Error(`Session ${sessionKey} did not open`);

  const stopListening = sessions.listen(app, () => sessionKey);

  const assign = (): void => {
    app.view = session.view$.get();
    app.surface = session.surface$.get();
    app.host = session.host$.get();
  };
  const unsubscribe = sessions.onChange(assign);
  const stopFollowingSeen = sessions.followSeen(() => sessionKey);
  assign();

  const dispose = (): void => {
    window.removeEventListener('pagehide', dispose);
    window.removeEventListener('message', receive);
    stopListening();
    stopFollowingSeen();
    unsubscribe();
    sessions.dispose();
  };
  window.addEventListener('pagehide', dispose, { once: true });
  return dispose;
}
