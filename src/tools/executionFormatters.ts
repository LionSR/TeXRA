/**
 * The one display model for the /executions surface: the listing lines, the
 * /executions/{id} summary line sets, and the sub-paths a run serves.
 *
 * Every fact comes off the session fold's `RunView`. The fold already decides
 * what a run is, what it is called, what may be said about its status and who
 * its parent is (PRD one-fold-three-renderers, 5.2), so nothing here reads a
 * durable row or re-derives liveness from a missing in-process handle.
 */

import {
  AgentCategory,
  countByStatus,
  STATUS_DISPLAY,
  type RunId,
  type RunIdentity,
  type TodoItem,
} from '@shared/schemas';
import type { RunView, SessionView } from '@shared/session/sessionView';
import { formatTimestamp } from '@utils/text/stringUtils';

/**
 * The display category of a run: an agent run shows its run mode
 * (`workflow` / `toolUse`), every other run shows what it IS
 * (`process` / `multiAgentWorkflow`).
 */
type RunDisplayCategory = AgentCategory | Exclude<RunIdentity['kind'], 'agent'>;

export function runDisplayCategory(run: RunView): RunDisplayCategory {
  return run.identity.kind === 'agent' ? run.category : run.identity.kind;
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

/** A tool-use run's task list; every other run has none. */
export function runTodos(run: RunView): readonly TodoItem[] {
  return run.category === AgentCategory.ToolUse ? run.todos : [];
}

/** Return paths available for a given display category. */
function getAvailablePaths(
  category: RunDisplayCategory,
  hasChildren: boolean,
): string[] {
  const common = [
    'config',
    'report',
    'result',
    ...(hasChildren ? ['children'] : []),
  ];
  switch (category) {
    case 'toolUse':
      return [...common, 'conversation', 'todos', 'workspace-files'];
    case 'workflow':
    case 'multiAgentWorkflow':
      return [...common, 'files'];
    case 'process':
      return [...common, 'output'];
    default:
      category satisfies never;
      return common;
  }
}

/**
 * What may be said about a run's status, in the fold's own words: the durable
 * phase, plus the clause naming the fact that forbids a terminal reading —
 * interrupted (nobody owns it and nothing recorded how it ended), held by
 * another TeXRA process, or unreadable. "No handle in this process" is never
 * on its own a reason to call a run finished, and the fold is what knows the
 * difference.
 */
export function formatRunStatus(run: RunView): string {
  return run.statusDetail === null
    ? run.status
    : `${run.status}: ${run.statusDetail}`;
}

/** Format one run as a listing line. */
export function formatListingLine(run: RunView): string {
  const ts = formatTimestamp(new Date(run.launchedAt).toISOString());
  const modelTag = run.model === null ? '' : `  ${run.model}`;
  const parentSuffix = run.parentId === null ? '' : `  parent=${run.parentId}`;
  const descSuffix = run.description ? `: ${run.description}` : '';
  return `${run.id}  ${ts}  ${run.label}  ${runDisplayCategory(run)}${modelTag}  [${formatRunStatus(run)}]${parentSuffix}${descSuffix}`;
}

/** Format a single child run as a summary line. */
export function formatChildLine(child: RunView): string {
  const ts = formatTimestamp(new Date(child.launchedAt).toISOString());
  const desc = child.description ? `: ${child.description}` : '';
  return `${child.id}  ${ts}  ${child.label}  [${formatRunStatus(child)}]${desc}`;
}

/** Format todo items as a checklist. */
export function formatTodoSection(todos: readonly TodoItem[]): string[] {
  return todos.map((t) => `${STATUS_DISPLAY[t.status].icon} ${t.content}`);
}

/** Format a todo header with counts. */
export function formatTodoHeader(
  runId: RunId,
  todos: readonly TodoItem[],
): string {
  const { completed, inProgress, pending } = countByStatus(todos);
  return `Tasks for ${runId} (${completed} done, ${inProgress} active, ${pending} pending):`;
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

/**
 * Build the todo/report/available-paths lines that close the summary.
 * Appended after the children lines, so this only needs whether there were
 * any children, not the rows themselves.
 */
export function buildSummaryTailLines(
  runId: RunId,
  category: RunDisplayCategory,
  hasChildren: boolean,
  todos: readonly TodoItem[],
  report: string | null,
  options: { readonly suppressReport?: boolean } = {},
): string[] {
  const lines: string[] = [];

  if (todos.length > 0) {
    lines.push('', ...formatTodoSection(todos));
  }

  if (report && options.suppressReport) {
    lines.push(
      '',
      `Result: delivered automatically to this parent run as a follow-up message. Use /executions/${runId}/report to read the persisted report explicitly.`,
    );
  } else if (report) {
    lines.push('', 'Result:', report);
  }

  const paths = getAvailablePaths(category, hasChildren);
  lines.push(
    '',
    `Available paths: ${paths.map((p) => `/executions/${runId}/${p}`).join(', ')}`,
  );

  return lines;
}
