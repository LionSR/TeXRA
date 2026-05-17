import type { ExecutionListingEntry, TodoEntry } from '@agent/storage';
import {
  type ExecutionHandle,
  type ExecutionStatusInfo,
  getHandle,
} from '@agent/runtime/executionRegistry';
import {
  EXECUTION_STATUS,
  STATUS_DISPLAY,
  TODO_STATUS,
  type TodoStatus,
} from '@shared/schemas';
import { isProcessAgent } from '@shared/streams/agentKind';

export function resolveExecutionDisplayCategory(
  agent: string | undefined,
  category: string | undefined,
): string | undefined {
  return isProcessAgent(agent) ? 'process' : category;
}

/** Return paths available for a given agent category. */
export function getAvailablePaths(
  category?: string,
  hasChildren?: boolean,
): string[] {
  const common = ['config', 'report'];
  if (hasChildren) common.push('children');
  switch (category) {
    case 'toolUse':
      return [...common, 'conversation', 'todos'];
    case 'workflow':
      return [...common, 'files'];
    case 'process':
      return [...common, 'output'];
    default:
      return [...common, 'conversation', 'todos', 'files', 'output'];
  }
}

/** Format status info as a display string. */
export function formatStatusInfo(info: ExecutionStatusInfo): string {
  return info.elapsed
    ? `${info.status} (${info.elapsed} elapsed)`
    : info.status;
}

/** Resolve the runtime status for an execution ID, using persisted terminal status as fallback. */
export function getExecutionStatusInfo(
  executionId: string,
  terminalStatus?: string,
): ExecutionStatusInfo {
  const handle = getHandle(executionId);
  if (handle) return handle.getStatus();
  return {
    status: terminalStatus ?? EXECUTION_STATUS.COMPLETED,
    elapsed: null,
  };
}

/** Format round progress as a display line, or empty string if unavailable. */
export function formatProgressLine(
  handle: ExecutionHandle | undefined,
): string {
  const progress = handle?.getProgress();
  if (
    progress?.currentRound === undefined ||
    progress.totalRounds === undefined
  ) {
    return '';
  }
  return `Progress: round ${progress.currentRound + 1}/${progress.totalRounds}`;
}

/** Format a listing entry as a single summary line. */
export function formatListingLine(entry: ExecutionListingEntry): string {
  const ts = entry.timestamp.replace('T', ' ').replace(/\.\d+Z$/, '');
  const info = getExecutionStatusInfo(entry.id, entry.terminalStatus);
  const category = resolveExecutionDisplayCategory(entry.agent, entry.category);
  const categoryTag = category ? `  ${category}` : '';
  const modelTag = category === 'process' ? '' : `  ${entry.model}`;
  const parentSuffix = entry.parentExecutionId
    ? `  parent=${entry.parentExecutionId}`
    : '';
  const descSuffix = entry.description ? `  — ${entry.description}` : '';
  return `${entry.id}  ${ts}  ${entry.agent}${categoryTag}${modelTag}  [${formatStatusInfo(info)}]${parentSuffix}${descSuffix}`;
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
