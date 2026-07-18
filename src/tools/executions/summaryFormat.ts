/**
 * Pure formatters for the /executions listing header and the
 * /executions/{id} summary view. Builds the running-handle and
 * completed-execution line sets, the per-child summary line, and the shared
 * todo/report/available-paths tail — kept free of I/O so showSummary and
 * listExecutions only fetch and delegate to these builders.
 */

import type { ChildRecord, ExecutionMeta, TodoEntry } from '@agent/storage';
import {
  getRunContextStreamId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import {
  AgentExecutionHandle,
  type ExecutionHandle,
  type ExecutionStatusInfo,
} from '@agent/runtime/ExecutionHandle';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { formatResultCount, formatTimestamp } from '@utils/text/stringUtils';
import {
  formatStatusInfo,
  formatTodoSection,
  getAvailablePaths,
  getExecutionStatusInfo,
} from '../executionFormatters';

/** Options controlling how showSummary renders a result report. */
export interface ExecutionSummaryOptions {
  readonly suppressAutoDeliveredSubagentReport?: boolean;
}

/**
 * True when `handle` is a tool-use subagent whose parent stream is the
 * calling stream — i.e. the caller already receives this subagent's report
 * automatically as a follow-up, so /executions/{id} shouldn't duplicate it.
 */
function isCallerParentOfToolUseSubagent(
  handle: unknown,
  callerStreamId: StreamTabId | undefined,
): boolean {
  return (
    callerStreamId != null &&
    handle instanceof AgentExecutionHandle &&
    handle.category === 'toolUse' &&
    handle.parentStreamId !== handle.childStreamId &&
    handle.parentStreamId === callerStreamId
  );
}

/** Whether a report already auto-delivered to the caller should be elided from the summary. */
export function shouldSuppressAutoDeliveredSubagentReport(
  options: ExecutionSummaryOptions,
  handle: unknown,
): boolean {
  if (!options.suppressAutoDeliveredSubagentReport) return false;
  return isCallerParentOfToolUseSubagent(
    handle,
    getRunContextStreamId(tryUseRunContext()),
  );
}

/** Build the header line for the paginated /executions listing. */
export function formatListingHeader(
  start: number,
  end: number,
  total: number,
  bgCount: number,
): string {
  const bgSuffix =
    bgCount > 0
      ? `, ${formatResultCount(bgCount, 'background process', 'background processes')} running`
      : '';
  return `Executions (showing ${start}–${end} of ${total}${bgSuffix}, most recent first):`;
}

/** Format a single child execution as a summary line. */
export function formatChildLine(
  child: ChildRecord,
  childMeta: ExecutionMeta | null | undefined,
): string {
  const info = getExecutionStatusInfo(child.id, childMeta?.terminalStatus);
  const ts = formatTimestamp(child.timestamp);
  const desc = childMeta?.description ? `  — ${childMeta.description}` : '';
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
  config: AgentConfig | null,
  category: string | undefined,
  info: ExecutionStatusInfo,
  meta: ExecutionMeta | null,
): string[] {
  const lines = [
    `Execution: ${executionId}`,
    `Agent: ${config?.agent ?? 'unknown'}`,
    ...(category ? [`Category: ${category}`] : []),
    ...(category === 'process' ? [] : [`Model: ${config?.model ?? 'default'}`]),
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
  category: string | undefined,
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
