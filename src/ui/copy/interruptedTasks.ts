/**
 * The open-time prompt (GUI design 2026-10-02, J5; ruling GQ5): the tasks a
 * closed or crashed TeXRA left interrupted, read from the view, and the copy
 * every host prints for them. The progress view paints it as a notice above
 * the composer, the TUI above its input; neither blocks typing.
 *
 * The list is the fold's: a root task in the `interrupted` group that this
 * window can resume. What blocks one (`RunView.resumeBlocked`) comes from
 * the session's follower, and the fix it names has one home, Settings ›
 * Plugins (the TUI's `/plugins`), which the notice links to.
 */
import type { ResumeBlocker, RunId } from '@shared/schemas';
import type { RunView, SessionView } from '@shared/session/sessionView';
import { formatResultCount } from '@utils/text/stringUtils';

/** One interrupted task, as the notice lists it. */
export interface InterruptedTask {
  readonly runId: RunId;
  readonly title: string;
  /** When it last did anything: the host words it ("3 h ago"). */
  readonly stoppedAt: number | null;
  /** "2 of 4 agents done", or null for a task that started none. */
  readonly agents: string | null;
  readonly blocked: ResumeBlocker | null;
}

/**
 * The root tasks this window can resume that no process holds and that did
 * not end, newest first. `dismissed` is the surface's "Not now".
 */
export function interruptedTasks(
  view: Pick<SessionView, 'runs'>,
  dismissed: ReadonlySet<RunId> = new Set(),
): InterruptedTask[] {
  return [...view.runs.values()]
    .filter(
      (run) =>
        run.parentId === null &&
        run.group === 'interrupted' &&
        run.actions.includes('resume') &&
        !dismissed.has(run.id),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((run) => ({
      runId: run.id,
      title: run.description || run.label,
      stoppedAt: run.lastTimestamp,
      agents: agentProgress(run),
      blocked: run.resumeBlocked,
    }));
}

function agentProgress(run: RunView): string | null {
  const { total, finished } = run.rollup;
  if (total === 0) return null;
  return `${finished} of ${formatResultCount(total, 'agent')} done`;
}

/** The notice's copy. */
export const INTERRUPTED_NOTICE = Object.freeze({
  heading: (count: number) =>
    count === 1 ? '1 task was interrupted' : `${count} tasks were interrupted`,
  resumeAll: 'Resume all',
  notNow: 'Not now',
  /** Where `texra.resumeOnOpen: auto` is set. */
  alwaysResume: 'Always resume: Settings › General',
  /** The TUI's lines under the list, in place of buttons. */
  tuiActions: (count: number) =>
    count === 1
      ? '/resume all continues it · /resume chooses a task · typing anything hides this'
      : '/resume all continues them · /resume chooses one · typing anything hides this',
});

/** What a blocked task waits for, in one line: "needs the zotero plugin,
 *  which is off". */
export function resumeBlockerLine(reason: ResumeBlocker): string {
  switch (reason.kind) {
    case 'agentMissing':
      return `needs the ${reason.name} agent, which is not installed`;
    case 'pluginOff':
      return `needs the ${reason.name} plugin, which is off`;
    case 'pluginUntrusted':
      return `needs the ${reason.name} plugin, which is not trusted as it is now`;
  }
}

/**
 * The fix a blocked task offers, or null when TeXRA has none to offer (a
 * missing agent's file is the user's to restore). Each opens the one home of
 * the plugin switch and its trust review, Settings › Plugins.
 */
export function resumeBlockerFix(reason: ResumeBlocker): string | null {
  switch (reason.kind) {
    case 'agentMissing':
      return null;
    case 'pluginOff':
      return 'Turn on';
    case 'pluginUntrusted':
      return 'Review';
  }
}
