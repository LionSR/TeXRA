/**
 * The open-time prompt: the tasks a
 * closed or crashed TeXRA left interrupted, read from the view, and the copy
 * every host prints for them. The progress view paints it as a notice above
 * the composer, the TUI above its input; neither blocks typing.
 *
 * The list is the view's: a root task in the `interrupted` group that this
 * window can resume. Why one cannot continue is the resume's own refusal.
 */
import { formatResultCount } from '@texra-ai/harness/transcript';
import type { RunView, SessionView, RunId } from '@texra-ai/harness/schemas';

/** One interrupted task, as the notice lists it. */
export interface InterruptedTask {
  readonly runId: RunId;
  readonly title: string;
  /** When it last did anything: the host words it ("3 h ago"). */
  readonly stoppedAt: number | null;
  /** "2 of 4 agents done", or null for a task that started none. */
  readonly agents: string | null;
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
      title: run.title,
      stoppedAt: run.lastTimestamp,
      agents: agentProgress(run),
    }));
}

function agentProgress(run: Pick<RunView, 'rollup'>): string | null {
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
  /** The TUI's lines under the list, in place of buttons. */
  tuiActions: (count: number) =>
    count === 1
      ? '/resume all continues it · /resume chooses a task · sending anything hides this'
      : '/resume all continues them · /resume chooses one · sending anything hides this',
});
