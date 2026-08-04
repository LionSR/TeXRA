import type { ExecutionListingEntry, TodoEntry } from '@agent/storage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { ExecutionStatusInfo } from '@agent/runtime/ExecutionHandle';
import { currentSession } from '@agent/runtime/SessionHandle';
import {
  STATUS_DISPLAY,
  TODO_STATUS,
  runIdentityName,
  type RunIdentity,
  type RunOutcome,
  type TodoStatus,
} from '@shared/schemas';
import type { AgentCategory } from '@shared/schemas/agent';
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
  config: Pick<AgentConfig, 'agentCategory'> | null | undefined,
): ExecutionDisplayCategory | undefined {
  if (!identity) return config?.agentCategory;
  return identity.kind === 'agent' ? config?.agentCategory : identity.kind;
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
        model: entry.identity.kind === 'agent' ? entry.agentConfig.model : null,
        category: executionDisplayCategory(entry.identity, entry.agentConfig),
      };
    case 'incomplete':
      return { agent: 'unknown', model: 'unknown', category: undefined };
  }
}

/** Return paths available for a given agent category. */
export function getAvailablePaths(
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
