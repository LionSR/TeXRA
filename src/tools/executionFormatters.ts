import type { ExecutionListingEntry, TodoEntry } from '@agent/storage';
import { type ExecutionStatusInfo } from '@agent/runtime/executionRegistry';
import { currentSession } from '@agent/runtime/SessionHandle';
import {
  EXECUTION_STATUS,
  ExecutionStatusSchema,
  STATUS_DISPLAY,
  TODO_STATUS,
  type TodoStatus,
} from '@shared/schemas';
import { isProcessAgent } from '@shared/streams/agentKind';
import { formatTimestamp } from '@utils/text/stringUtils';

export function resolveExecutionDisplayCategory(
  agent: string | undefined,
  category: string | undefined,
): string | undefined {
  // Raw detail reads have not crossed the listing normalization boundary;
  // normalized listing rows use their discriminated `kind` below instead.
  return isProcessAgent(agent) ? 'process' : category;
}

function listingDisplay(entry: ExecutionListingEntry): {
  agent: string;
  model: string | null;
  category: string | undefined;
} {
  switch (entry.kind) {
    case 'agent':
      return {
        agent: entry.agentConfig.agent,
        model: entry.agentConfig.model,
        category: entry.runtimeCategory ?? entry.agentConfig.agentCategory,
      };
    case 'process':
      return {
        agent: entry.agentConfig.agent,
        model: null,
        category: 'process',
      };
    case 'incomplete':
      return {
        agent: 'unknown',
        model: entry.runtimeCategory === 'process' ? null : 'unknown',
        category: entry.runtimeCategory,
      };
  }
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
      return [...common, 'conversation', 'todos', 'workspace-files'];
    case 'workflow':
      return [...common, 'files'];
    case 'process':
      return [...common, 'output'];
    default:
      return [
        ...common,
        'conversation',
        'todos',
        'files',
        'workspace-files',
        'output',
      ];
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
  const session = currentSession();
  const handle = session.executions.getHandle(executionId);
  if (handle) return session.executions.getStatus(handle);

  const persistedStatus = ExecutionStatusSchema.safeParse(terminalStatus);
  let status: ExecutionStatusInfo['status'];
  if (persistedStatus.success) {
    status = persistedStatus.data;
  } else if (terminalStatus === undefined) {
    status = EXECUTION_STATUS.COMPLETED;
  } else {
    status = 'unknown';
  }
  return { status, elapsed: null };
}

/** Format a listing entry as a single summary line. */
export function formatListingLine(entry: ExecutionListingEntry): string {
  const ts = formatTimestamp(entry.timestamp);
  const info = getExecutionStatusInfo(entry.id, entry.terminalStatus);
  const { agent, model, category } = listingDisplay(entry);
  const categoryTag = category ? `  ${category}` : '';
  const modelTag = model == null ? '' : `  ${model}`;
  const parentSuffix = entry.parentExecutionId
    ? `  parent=${entry.parentExecutionId}`
    : '';
  const descSuffix = entry.description ? `  — ${entry.description}` : '';
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
