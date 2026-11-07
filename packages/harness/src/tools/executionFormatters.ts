/**
 * The one display model for the /executions surface: the listing lines, the
 * /executions/{id} summary line sets, and the sub-paths a run serves.
 *
 * Every fact comes off the session fold's `RunView`. The fold already decides
 * what a run is, what it is called, what may be said about its status and who
 * its parent is, so nothing here reads a
 * durable row or re-derives liveness from a missing in-process handle.
 */

import { type RunId, type RunIdentity } from '@shared/schemas';
import type { RunView, SessionView } from '@shared/session/sessionView';

/**
 * The display category of a run: an agent run is a conversation (`agent`)
 * or a task (`task`, a run opened on a plugin's recipe); every other run
 * shows what it IS (`process` / `script`).
 */
export type RunDisplayCategory = 'task' | RunIdentity['kind'];

/** Every display category, for a path every run serves. */
export const ALL_KINDS: readonly RunDisplayCategory[] = [
  'agent',
  'task',
  'process',
  'script',
];

export function runDisplayCategory(run: RunView): RunDisplayCategory {
  return run.identity.kind === 'agent' && run.recipe
    ? 'task'
    : run.identity.kind;
}

/**
 * The runs the fold lists under `runId`, in its own child ordering. A
 * detached or deleted child has already left `childIds`, so there is no
 * second parentage rule here.
 */
export function childRunViews(view: SessionView, runId: RunId): RunView[] {
  return (view.runs.get(runId)?.childIds ?? []).flatMap((id) => {
    const child = view.runs.get(id);
    return child === undefined ? [] : [child];
  });
}

/**
 * What may be said about a run's status, in the fold's own words: the durable
 * phase, plus the clause naming the fact that forbids a terminal reading —
 * interrupted (nobody owns it and nothing recorded how it ended), held by
 * another process, or unreadable. "No handle in this process" is never
 * on its own a reason to call a run finished, and the fold is what knows the
 * difference.
 */
export function formatRunStatus(run: RunView): string {
  const notice = describeRunNotice(run);
  return notice === null ? run.status : `${run.status}: ${notice}`;
}

/** The fold's notice on `run` (`RunView.statusNotice`) as the model reads
 *  it; null when there is none. Hosts word it through the app's copy. */
export function describeRunNotice(run: RunView): string | null {
  const notice = run.statusNotice;
  switch (notice?.kind) {
    case undefined:
      return null;
    case 'damaged':
      return 'part of its saved history is damaged, so it cannot be opened or resumed';
    case 'earlierBuild':
      return 'an earlier build wrote it, and this build cannot open it';
    case 'interrupted':
      return 'the process running it stopped before it finished; resume it to continue';
    case 'lost':
      return notice.message;
  }
}

/** One /executions line. `marks` is what the line says about the run
 *  relative to the caller: its relation and unread input. */
export function formatListingLine(run: RunView, marks: string): string {
  const ts = new Date(run.launchedAt)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  const modelTag = run.model === null ? '' : `  ${run.model}`;
  const parentSuffix = run.parentId === null ? '' : `  parent=${run.parentId}`;
  const markSuffix = marks ? `  ${marks}` : '';
  const descSuffix = run.description ? `: ${run.description}` : '';
  return `${run.id}  ${ts}  ${run.label}  ${runDisplayCategory(run)}${modelTag}  [${formatRunStatus(run)}]${parentSuffix}${markSuffix}${descSuffix}`;
}

/** Format a single child run as a summary line. */
export function formatChildLine(child: RunView): string {
  const ts = new Date(child.launchedAt)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  const desc = child.description ? `: ${child.description}` : '';
  return `${child.id}  ${ts}  ${child.label}  [${formatRunStatus(child)}]${desc}`;
}

// ============================================================================
// /executions/{id} summary
// ============================================================================

/** The head of the /executions/{id} summary: one line set for every run,
 *  running or finished, because one fold answers for both. */
export function buildSummaryLines(run: RunView): string[] {
  const lines = [
    `Run: ${run.id}`,
    `Agent: ${run.label}`,
    `Category: ${runDisplayCategory(run)}`,
    ...(run.model === null ? [] : [`Model: ${run.model}`]),
    `Timestamp: ${new Date(run.launchedAt).toISOString()}`,
    `Status: ${formatRunStatus(run)}`,
  ];

  if (run.description) {
    lines.push(`Description: ${run.description}`);
  }

  if (run.parentId !== null) {
    lines.push(`Parent: ${run.parentId}`);
  }

  return lines;
}

/** Build the report and available-paths lines that close the summary; the
 *  paths are the ones the tool's route table serves for the run's kind. */
export function buildSummaryTailLines(
  runId: RunId,
  paths: readonly string[],
  report: string | null,
): string[] {
  const lines: string[] = [];

  if (report) lines.push('', 'Result:', report);

  lines.push(
    '',
    `Available paths: ${paths.map((p) => `/executions/${runId}/${p}`).join(', ')}`,
  );

  return lines;
}
