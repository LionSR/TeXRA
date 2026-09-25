// What the desktop tells the user about projects they are not looking at: the
// dock badge counts every decision waiting on them across the open projects,
// and a top-level run that starts waiting or finishes where the user cannot
// see it raises one OS notification that leads back to it.

import { app, Notification, type BrowserWindow } from 'electron';
import { Context, Effect, Stream, SubscriptionRef } from 'effect';

import type { RunId } from '@shared/schemas';
import { projectDisplayOf } from '@shared/session/hostSnapshot';
import type { RunView, SessionView } from '@shared/session/sessionView';

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
}

export class DesktopAttentionPort extends Context.Service<
  DesktopAttentionPort,
  DesktopAttentionPortShape
>()('@texra/desktop/DesktopAttentionPort') {}

// Held until clicked or closed: a notification the collector reclaims can no
// longer deliver its click.
const liveNotifications = new Set<Notification>();

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
      const release = () => liveNotifications.delete(notification);
      notification.on('click', () => {
        release();
        options.reveal(key, runId);
      });
      notification.on('close', release);
      liveNotifications.add(notification);
      notification.show();
    },
  };
}

/** The line a notification prints for a run that changed, or undefined
 *  when the change is not one the user is told about. */
function attentionLine(
  run: RunView,
  previous: RunView | undefined,
): string | undefined {
  // A run first seen in its current state is history, not news.
  if (previous === undefined || run.parentId !== null) return undefined;
  const name = run.description ?? run.label;
  if (run.group === 'waiting' && previous.group !== 'waiting')
    return `${name} is waiting for you.`;
  if (run.durableOutcome !== null && previous.durableOutcome === null)
    return `${name}: ${run.statusLabel}.`;
  return undefined;
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
      for (const key of latest.keys())
        if (!openKeys.has(key)) latest.delete(key);
      const previous = latest.get(project.key);
      latest.set(project.key, view);
      if (
        previous !== undefined &&
        !(activeKey === project.key && port.windowFocused())
      ) {
        const title = projectDisplayOf(project.key, project.root).name;
        for (const run of view.runs.values()) {
          const body = attentionLine(run, previous.runs.get(run.id));
          if (body !== undefined)
            port.notify({ title, body, key: project.key, runId: run.id });
        }
      }
      let waiting = 0;
      for (const each of latest.values()) waiting += each.rollup.waiting;
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
