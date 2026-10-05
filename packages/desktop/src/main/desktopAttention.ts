// What the desktop tells the user about projects they are not looking at: the
// dock badge counts the requests this window can answer across the open
// projects (`attentionOf`), and a new one, or a top-level run that finishes,
// where the user cannot see it raises one OS notification that leads back to
// its run.

import { app, Notification, type BrowserWindow } from 'electron';
import { Context, Effect, Queue, Stream, SubscriptionRef } from 'effect';

import {
  attentionOf,
  type RunView,
  type SessionView,
} from '@shared/session/sessionView';

import { DesktopProjects, type DesktopProject } from './desktopProjects.js';
import type { RunId } from '@texra-ai/harness/schemas';

/** The host's attention surfaces, served by the Electron composition root. */
interface DesktopAttentionPortShape {
  /** The window is on screen and focused: what it shows, the user sees. */
  windowFocused(): boolean;
  /** The count on the app icon; 0 clears it. */
  setBadgeCount(count: number): void;
  /** Project `key`'s OS notification, replacing its last; clicking it shows
   *  `runId` there. */
  notify(notification: {
    readonly title: string;
    readonly body: string;
    readonly key: string;
    readonly runId: RunId;
  }): void;
  /** Close project `key`'s notification: the user is looking at it. */
  dismiss(key: string): void;
  /** Each time a window of the app gains focus. */
  readonly focused: Stream.Stream<void>;
}

export class DesktopAttentionPort extends Context.Service<
  DesktopAttentionPort,
  DesktopAttentionPortShape
>()('@texra/desktop/DesktopAttentionPort') {}

// Each project's one live notification, held so its click can still be
// delivered (one the collector reclaims cannot deliver it). A newer one for
// the project replaces it, and looking at the project dismisses it: the OS
// does not promise a `close`, so at most one per open project is ever held.
const liveNotifications = new Map<string, Notification>();

/** The port over Electron: the app icon's badge and the OS notification
 *  centre, clicks leading back through `reveal`. */
export function electronAttentionPort(options: {
  window(): BrowserWindow | null;
  reveal(key: string, runId: RunId): void;
}): DesktopAttentionPortShape {
  return {
    windowFocused: () => {
      const window = options.window();
      return window !== null && !window.isDestroyed() && window.isFocused();
    },
    setBadgeCount: (count) => {
      app.setBadgeCount(count);
    },
    notify: ({ title, body, key, runId }) => {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title, body });
      const release = () => {
        if (liveNotifications.get(key) === notification)
          liveNotifications.delete(key);
      };
      notification.on('click', () => {
        release();
        options.reveal(key, runId);
      });
      notification.on('close', release);
      notification.on('failed', release);
      const superseded = liveNotifications.get(key);
      liveNotifications.set(key, notification);
      superseded?.close();
      notification.show();
    },
    dismiss: (key) => {
      const shown = liveNotifications.get(key);
      liveNotifications.delete(key);
      shown?.close();
    },
    focused: Stream.callback<void>((queue) =>
      Effect.gen(function* () {
        const onFocus = () => {
          Queue.offerUnsafe(queue, undefined);
        };
        app.on('browser-window-focus', onFocus);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            app.off('browser-window-focus', onFocus);
          }),
        );
      }),
    ),
  };
}

/** A top-level run that reached its outcome since `previous`: the one
 *  change besides a new request the user is told about. A run first seen in
 *  its current state is history, not news. */
function finishedLine(
  run: RunView,
  previous: RunView | undefined,
): string | undefined {
  if (previous === undefined || run.parentId !== null) return undefined;
  if (run.durableOutcome === null || previous.durableOutcome !== null)
    return undefined;
  return `${run.description ?? run.label}: ${run.statusLabel}.`;
}

/**
 * Follow every open project's view for the process lifetime. The first view
 * of a project only records it, so reopening projects at launch or a project
 * opening later notifies nothing.
 */
export const followDesktopAttention = Effect.gen(function* () {
  const projects = yield* DesktopProjects;
  const port = yield* DesktopAttentionPort;
  const latest = new Map<string, SessionView>();
  let badge = 0;
  const observe = (project: DesktopProject, view: SessionView) =>
    Effect.sync(() => {
      const { projects: open, activeKey } = SubscriptionRef.getUnsafe(
        projects.state,
      );
      const openKeys = new Set([
        projects.fallback().key,
        ...open.map(({ key }) => key),
      ]);
      for (const key of latest.keys()) {
        if (openKeys.has(key)) continue;
        latest.delete(key);
        port.dismiss(key);
      }
      const previous = latest.get(project.key);
      latest.set(project.key, view);
      const seen = activeKey === project.key && port.windowFocused();
      if (seen) port.dismiss(project.key);
      if (previous !== undefined && !seen) {
        // One notification per update, replacing the project's last: its
        // lines are every run this update asks about, its click the first.
        const notices: { readonly runId: RunId; readonly line: string }[] = [];
        for (const { runId } of attentionOf(view, previous).arrived) {
          const run = view.runs.get(runId);
          if (run === undefined || notices.some((n) => n.runId === runId))
            continue;
          const line = `${run.description ?? run.label} is waiting for you.`;
          notices.push({ runId, line });
        }
        for (const run of view.runs.values()) {
          const line = finishedLine(run, previous.runs.get(run.id));
          if (line !== undefined) notices.push({ runId: run.id, line });
        }
        const first = notices[0];
        if (first !== undefined) {
          port.notify({
            title: project.display.name,
            body: notices.map((notice) => notice.line).join('\n'),
            key: project.key,
            runId: first.runId,
          });
        }
      }
      let waiting = 0;
      for (const each of latest.values())
        waiting += attentionOf(each).requests.length;
      if (waiting !== badge) {
        badge = waiting;
        port.setBadgeCount(waiting);
      }
    });
  // Focus alone changes no view, yet it is when the user sees the active
  // project: its notifications go then too.
  const dismissActive = port.focused.pipe(
    Stream.runForEach(() =>
      Effect.sync(() =>
        port.dismiss(SubscriptionRef.getUnsafe(projects.state).activeKey),
      ),
    ),
  );
  const follow = SubscriptionRef.changes(projects.state).pipe(
    Stream.switchMap(({ projects: open }) =>
      Stream.mergeAll(
        [projects.fallback(), ...open].map((project) =>
          project.session.viewChanges.pipe(
            Stream.map((view) => [project, view] as const),
          ),
        ),
        { concurrency: 'unbounded' },
      ),
    ),
    Stream.runForEach(([project, view]) => observe(project, view)),
  );
  yield* Effect.all([follow, dismissActive], { concurrency: 'unbounded' });
});
