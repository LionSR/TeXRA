/**
 * The one display model for the /executions surface: the listing lines, the
 * /executions/{id} summary line sets, and the predicates both answer their
 * questions with — what a run's display category is, whether it shows a model,
 * and which sub-paths it serves. Pure formatting, no I/O, so `listExecutions`
 * and `showSummary` only fetch and delegate here.
 */

import type {
  ChildRecord,
  ExecutionListingEntry,
  TodoEntry,
} from '@agent/storage';
import {
  isAgentRunRecord,
  type RunRecord,
} from '@agent/core/definition/RunRecord';
import {
  getRunContextStreamId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import type {
  AgentExecutionHandle,
  ExecutionStatusInfo,
} from '@agent/runtime/ExecutionHandle';
import { currentSession } from '@agent/runtime/SessionHandle';
import type {
  AgentCategory,
  ExecutionId,
  ExecutionMeta,
  RunIdentity,
  RunOutcome,
  TodoStatus,
} from '@shared/schemas';
import { runIdentityName, STATUS_DISPLAY, TODO_STATUS } from '@shared/schemas';
import { formatTimestamp } from '@utils/text/stringUtils';

/**
 * The display category of a run: an agent run shows its execution mode
 * (`workflow` / `toolUse`), every other run shows what it IS
 * (`process` / `multiAgentWorkflow`). Identity-less legacy rows fall back to the
 * config's category.
 */
export type ExecutionDisplayCategory =
  AgentCategory | Exclude<RunIdentity['kind'], 'agent'>;

export function executionDisplayCategory(
  identity: RunIdentity | undefined,
  record: RunRecord | null | undefined,
): ExecutionDisplayCategory | undefined {
  const agentCategory =
    record && isAgentRunRecord(record) ? record.agentCategory : undefined;
  if (!identity) return agentCategory;
  return identity.kind === 'agent' ? agentCategory : identity.kind;
}

/**
 * The model a run displays, or `null` when it displays none — one rule for the
 * listing and the summary, so the two cannot disagree about the same run.
 *
 * Honest non-agent records (a background process, a multi-agent workflow)
 * carry a model only when a real one backs the run, and then it is shown; a
 * legacy fabricated `AgentConfig` on a non-agent identity stays suppressed.
 */
function executionDisplayModel(
  identity: RunIdentity | undefined,
  record: RunRecord | null | undefined,
): string | null {
  if (!record) return null;
  if (!isAgentRunRecord(record)) return record.model ?? null;
  return identity === undefined || identity.kind === 'agent'
    ? record.model
    : null;
}

function listingDisplay(entry: ExecutionListingEntry): {
  agent: string;
  model: string | null;
  category: string | undefined;
} {
  switch (entry.kind) {
    case 'run':
      return {
        agent: runIdentityName(entry.identity),
        model: executionDisplayModel(entry.identity, entry.record),
        category: executionDisplayCategory(entry.identity, entry.record),
      };
    case 'incomplete':
      return { agent: 'unknown', model: 'unknown', category: undefined };
  }
}

/** Return paths available for a given agent category. */
function getAvailablePaths(
  category?: ExecutionDisplayCategory,
  hasChildren?: boolean,
): string[] {
  const common = ['config', 'report'];
  if (hasChildren) common.push('children');
  switch (category) {
    case 'toolUse':
      return [...common, 'conversation', 'todos', 'workspace-files'];
    case 'workflow':
    case 'multiAgentWorkflow':
      return [...common, 'files'];
    case 'process':
      return [...common, 'output'];
    case undefined:
      // Unknown category (incomplete legacy row): offer every path.
      return [
        ...common,
        'conversation',
        'todos',
        'files',
        'workspace-files',
        'output',
      ];
    default:
      category satisfies never;
      return common;
  }
}

/** Format status info as a display string. */
export function formatStatusInfo(info: ExecutionStatusInfo): string {
  return info.elapsed
    ? `${info.status} (${info.elapsed} elapsed)`
    : info.status;
}

/** Resolve the runtime status for an execution ID: live phase, else the persisted outcome. */
export function getExecutionStatusInfo(
  executionId: string,
  outcome?: RunOutcome,
): ExecutionStatusInfo {
  const session = currentSession();
  const handle = session.executions.getHandle(executionId);
  if (handle) return session.executions.getStatus(handle);
  return { status: outcome ?? 'unknown', elapsed: null };
}

/** Format a listing entry as a single summary line. */
export function formatListingLine(entry: ExecutionListingEntry): string {
  const ts = formatTimestamp(entry.timestamp);
  const info = getExecutionStatusInfo(entry.id, entry.outcome);
  const { agent, model, category } = listingDisplay(entry);
  const categoryTag = category ? `  ${category}` : '';
  const modelTag = model == null ? '' : `  ${model}`;
  const parentSuffix = entry.parentExecutionId
    ? `  parent=${entry.parentExecutionId}`
    : '';
  const descSuffix = entry.description ? `: ${entry.description}` : '';
  return `${entry.id}  ${ts}  ${agent}${categoryTag}${modelTag}  [${formatStatusInfo(info)}]${parentSuffix}${descSuffix}`;
}

function getTodoStatusIcon(status: string | undefined): string {
  return (
    STATUS_DISPLAY[status as TodoStatus]?.icon ??
    STATUS_DISPLAY[TODO_STATUS.PENDING].icon
  );
}

/** Format todo items as a checklist. */
export function formatTodoSection(todos: TodoEntry[]): string[] {
  return todos.map((t) => {
    const icon = getTodoStatusIcon(t.status);
    return `${icon} ${t.content ?? '(no description)'}`;
  });
}

/** Format a todo header with counts. */
export function formatTodoHeader(
  executionId: string,
  todos: TodoEntry[],
): string {
  const completed = todos.filter((t) => t.status === 'completed').length;
  const inProgress = todos.filter((t) => t.status === 'in_progress').length;
  return `Tasks for ${executionId} (${completed} done, ${inProgress} active, ${todos.length - completed - inProgress} pending):`;
}

// ============================================================================
// /executions/{id} summary
// ============================================================================

/** Options controlling how showSummary renders a result report. */
export interface ExecutionSummaryOptions {
  readonly suppressAutoDeliveredSubagentReport?: boolean;
}

/**
 * Whether a report already auto-delivered to the caller should be elided from
 * the summary: true when `handle` is a tool-use child whose parent stream is
 * the calling stream — i.e. the caller already receives this child's report
 * automatically as a follow-up, so /executions/{id} shouldn't duplicate it.
 * Deliberately identity-kind-agnostic: background bash processes
 * (`kind: 'process'`, category ToolUse) auto-deliver their reports exactly
 * like delegated agents do, and must stay suppressed too.
 */
export function shouldSuppressAutoDeliveredSubagentReport(
  options: ExecutionSummaryOptions,
  handle: AgentExecutionHandle,
): boolean {
  if (!options.suppressAutoDeliveredSubagentReport) return false;
  return (
    handle.category === 'toolUse' &&
    handle.isOwnedBy(getRunContextStreamId(tryUseRunContext()))
  );
}

/** Format a single child execution as a summary line. */
export function formatChildLine(
  child: ChildRecord,
  childMeta: ExecutionMeta | null | undefined,
): string {
  const info = getExecutionStatusInfo(child.id, childMeta?.outcome);
  const ts = formatTimestamp(child.timestamp);
  const desc = childMeta?.description ? `: ${childMeta.description}` : '';
  return `${child.id}  ${ts}  ${child.agent}  [${formatStatusInfo(info)}]${desc}`;
}

/** Build the summary lines for a still-running execution (in-memory handle). */
export function buildRunningSummaryLines(
  executionId: ExecutionId,
  handle: AgentExecutionHandle,
  category: ExecutionDisplayCategory | undefined,
  info: ExecutionStatusInfo,
  meta: ExecutionMeta | null,
): string[] {
  const lines = [
    `Execution: ${executionId}`,
    `Agent: ${handle.agentName}`,
    ...(category ? [`Category: ${category}`] : []),
    `Started: ${new Date(handle.startedAt).toISOString()}`,
    `Status: ${formatStatusInfo(info)}`,
  ];

  if (meta?.parentExecutionId) {
    lines.push(`Parent: ${meta.parentExecutionId}`);
  }

  return lines;
}

/** Build the summary lines for a completed execution (full KV fetch). */
export function buildCompletedSummaryLines(
  executionId: ExecutionId,
  record: RunRecord | null,
  identity: RunIdentity | undefined,
  category: ExecutionDisplayCategory | undefined,
  info: ExecutionStatusInfo,
  meta: ExecutionMeta | null,
): string[] {
  const name =
    record && (isAgentRunRecord(record) ? record.agent : record.name);
  const model = executionDisplayModel(identity, record);
  const lines = [
    `Execution: ${executionId}`,
    `Agent: ${name ?? 'unknown'}`,
    ...(category ? [`Category: ${category}`] : []),
    ...(model === null ? [] : [`Model: ${model}`]),
    `Timestamp: ${meta?.timestamp ?? 'unknown'}`,
    `Status: ${formatStatusInfo(info)}`,
  ];

  if (meta?.description) {
    lines.push(`Description: ${meta.description}`);
  }

  if (meta?.parentExecutionId) {
    lines.push(`Parent: ${meta.parentExecutionId}`);
  }

  return lines;
}

/**
 * Build the todo/report/available-paths lines shared by both showSummary
 * branches. Appended after the (I/O-fetched) children lines, so this only
 * needs whether there were any children, not the records themselves.
 */
export function buildSummaryTailLines(
  executionId: ExecutionId,
  category: ExecutionDisplayCategory | undefined,
  hasChildren: boolean,
  todos: TodoEntry[],
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
      `Result: delivered automatically to this parent stream as a follow-up message. Use /executions/${executionId}/report to read the persisted report explicitly.`,
    );
  } else if (report) {
    lines.push('', 'Result:', report);
  }

  const paths = getAvailablePaths(category, hasChildren);
  lines.push(
    '',
    `Available paths: ${paths.map((p) => `/executions/${executionId}/${p}`).join(', ')}`,
  );

  return lines;
}
