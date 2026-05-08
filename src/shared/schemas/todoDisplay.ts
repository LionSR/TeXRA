import { TODO_STATUS, type TodoStatus } from './todo';

/** wa-icon names for each todo/plan step status (used in webview components). */
export const STATUS_ICONS: Record<TodoStatus, string> = {
  [TODO_STATUS.PENDING]: 'circle-outline',
  [TODO_STATUS.IN_PROGRESS]: 'loading',
  [TODO_STATUS.COMPLETED]: 'pass-filled',
};

/** Text-based status display for tool output formatting. */
export const STATUS_DISPLAY: Record<
  TodoStatus,
  { icon: string; label: string }
> = {
  [TODO_STATUS.PENDING]: { icon: '\u25CB', label: 'PENDING' },
  [TODO_STATUS.IN_PROGRESS]: { icon: '\u25D0', label: 'IN PROGRESS' },
  [TODO_STATUS.COMPLETED]: { icon: '\u25CF', label: 'COMPLETED' },
};

/** Count items by status. Works with any array of objects having a `status` field. */
export interface StatusCounts {
  completed: number;
  inProgress: number;
  pending: number;
}

export function countByStatus(
  items: readonly { status: TodoStatus }[],
): StatusCounts {
  let completed = 0;
  let inProgress = 0;
  let pending = 0;
  for (const item of items) {
    if (item.status === TODO_STATUS.COMPLETED) completed++;
    else if (item.status === TODO_STATUS.IN_PROGRESS) inProgress++;
    else pending++;
  }
  return { completed, inProgress, pending };
}
