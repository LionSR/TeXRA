import type { TeXRAIconName } from '@shared/wa/iconNames';

import { TODO_STATUS, type TodoStatus } from './todo';

/** wa-icon names for each todo/plan step status (used in webview components). */
export const STATUS_ICONS: Readonly<Record<TodoStatus, TeXRAIconName>> =
  Object.freeze({
    [TODO_STATUS.PENDING]: 'circle',
    [TODO_STATUS.IN_PROGRESS]: 'spinner',
    [TODO_STATUS.COMPLETED]: 'circle-check',
  });

/** Text-based status display for tool output formatting. */
export const STATUS_DISPLAY: Readonly<
  Record<TodoStatus, Readonly<{ icon: string; label: string }>>
> = Object.freeze({
  [TODO_STATUS.PENDING]: Object.freeze({ icon: '\u25CB', label: 'PENDING' }),
  [TODO_STATUS.IN_PROGRESS]: Object.freeze({
    icon: '\u25D0',
    label: 'IN PROGRESS',
  }),
  [TODO_STATUS.COMPLETED]: Object.freeze({
    icon: '\u25CF',
    label: 'COMPLETED',
  }),
});

/** Count items by status. Works with any array of objects having a `status` field. */
interface StatusCounts {
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
