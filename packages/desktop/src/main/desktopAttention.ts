// What the desktop tells the user about projects they are not looking at: the
// dock badge counts the requests this window can answer across the open
// projects (`attentionOf`), and a new one, or a top-level run that finishes,
// where the user cannot see it raises one OS notification that leads back to
// its run.

import { app, Notification, type BrowserWindow } from 'electron';
import { Context, Effect, Stream, SubscriptionRef } from 'effect';

import type { RunId } from '@shared/schemas';
import {
  attentionOf,
  type RunView,
  type SessionView,
} from '@shared/session/sessionView';

import { DesktopProjects, type DesktopProject } from './desktopProjects.js';

/** The host's attention surfaces, served by the Electron composition root. */
interface DesktopAttentionPortShape {
  /** The window is on screen and focused: what it shows, the user sees. */
  windowFocused(): boolean;
  /** The count on the app icon; 0 clears it. */
  setBadgeCount(count: number): void;
  /** One OS notification; clicking it shows `runId` in the project `key`. */
  notify(notification: {
    readonly title: string;
    readonly body: string;
    readonly key: string;
    readonly runId: RunId;
  }): void;
  /** Close project `key`'s notifications: the user is looking at it. */
  dismiss(key: string): void;
}

export class DesktopAttentionPort extends Context.Service<
  DesktopAttentionPort,
  DesktopAttentionPortShape
>()('@texra/desktop/DesktopAttentionPort') {}

// Each project's shown notifications, held so a click can still be delivered
// (one the collector reclaims cannot deliver it) until it is clicked, closed
// or failed, or the user looks at the project, which dismisses them: the OS
// does not promise a `close`, so without that they were held forever.
const liveNotifications = new Map<string, Set<Notification>>();

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
      const shown = liveNotifications.get(key) ?? new Set<Notification>();
      const release = () => {
        shown.delete(notification);
        if (shown.size === 0 && liveNotifications.get(key) === shown)
          liveNotifications.delete(key);
      };
      notification.on('click', () => {
        release();
        options.reveal(key, runId);
      });
      notification.on('close', release);
      notification.on('failed', release);
      liveNotifications.set(key, shown.add(notification));
      notification.show();
    },
    dismiss: (key) => {
      const shown = liveNotifications.get(key);
      liveNotifications.delete(key);
      for (const notification of shown ?? []) notification.close();
    },
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
        const title = project.display.name;
        const notify = (runId: RunId, body: string) =>
          port.notify({ title, body, key: project.key, runId });
        const asking = new Set<RunId>();
        for (const { runId } of attentionOf(view, previous).arrived) {
          const run = view.runs.get(runId);
          if (run === undefined || asking.has(runId)) continue;
          asking.add(runId);
          notify(runId, `${run.description ?? run.label} is waiting for you.`);
        }
        for (const run of view.runs.values()) {
          const body = finishedLine(run, previous.runs.get(run.id));
          if (body !== undefined) notify(run.id, body);
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
  yield* SubscriptionRef.changes(projects.state).pipe(
    Stream.switchMap(({ projects: open }) =>
      Stream.mergeAll(
        [projects.fallback(), ...open].map((project) =>
          SubscriptionRef.changes(project.session.view).pipe(
            Stream.map((view) => [project, view] as const),
          ),
        ),
        { concurrency: 'unbounded' },
      ),
    ),
    Stream.runForEach(([project, view]) => observe(project, view)),
  );
});
