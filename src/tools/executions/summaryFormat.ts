/**
 * Pure formatters for the /executions listing header and the
 * /executions/{id} summary view. Builds the running-handle and
 * completed-execution line sets, the per-child summary line, and the shared
 * todo/report/available-paths tail — kept free of I/O so showSummary and
 * listExecutions only fetch and delegate to these builders.
 */

import type { ChildRecord, TodoEntry } from '@agent/storage';
import {
  getRunContextStreamId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import {
  AgentExecutionHandle,
  type ExecutionHandle,
  type ExecutionStatusInfo,
} from '@agent/runtime/ExecutionHandle';
import {
  isAgentRunRecord,
  type RunRecord,
} from '@agent/core/definition/RunRecord';
import type { ExecutionId, ExecutionMeta } from '@shared/schemas';
import { formatTimestamp } from '@utils/text/stringUtils';
import {
  formatStatusInfo,
  formatTodoSection,
  getAvailablePaths,
  getExecutionStatusInfo,
  type ExecutionDisplayCategory,
} from '../executionFormatters';

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
  handle: ExecutionHandle,
): boolean {
  if (!options.suppressAutoDeliveredSubagentReport) return false;
  return (
    handle instanceof AgentExecutionHandle &&
    handle.category === 'toolUse' &&
    handle.isOwnedBy(getRunContextStreamId(tryUseRunContext()))
  );
}

/** Build the header line for the paginated /executions listing. */
export function formatListingHeader(
  start: number,
  end: number,
  total: number,
): string {
  return `Executions (showing ${start}–${end} of ${total}, most recent first):`;
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
  handle: ExecutionHandle,
  info: ExecutionStatusInfo,
  meta: ExecutionMeta | null,
): string[] {
  const lines = [
    `Execution: ${executionId}`,
    `Agent: ${handle.agentName}`,
    `Category: ${handle.category}`,
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
  category: ExecutionDisplayCategory | undefined,
  info: ExecutionStatusInfo,
  meta: ExecutionMeta | null,
): string[] {
  const name =
    record && (isAgentRunRecord(record) ? record.agent : record.name);
  const lines = [
    `Execution: ${executionId}`,
    `Agent: ${name ?? 'unknown'}`,
    ...(category ? [`Category: ${category}`] : []),
    ...(category === 'process' || category === 'multiAgentWorkflow'
      ? []
      : [`Model: ${record?.model ?? 'default'}`]),
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

/** Options controlling the shared summary tail (children/todos/report). */
export interface SummaryTailOptions {
  readonly suppressReport?: boolean;
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
  options: SummaryTailOptions = {},
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
