import type { TeXRAIconName } from '@shared/wa/iconNames';

import { TODO_STATUS, type TodoStatus } from './todo';

/**
 * Per-status presentation for todo/plan steps: the webview's wa-icon name, the
 * text glyph, and the human label, shared by tool output formatting and by the
 * webview and terminal renderers. One casing for every host.
 */
export const STATUS_DISPLAY: Readonly<
  Record<
    TodoStatus,
    Readonly<{ icon: string; waIcon: TeXRAIconName; label: string }>
  >
> = Object.freeze({
  [TODO_STATUS.PENDING]: Object.freeze({
    icon: '\u25CB',
    waIcon: 'circle',
    label: 'Pending',
  }),
  [TODO_STATUS.IN_PROGRESS]: Object.freeze({
    icon: '\u25D0',
    waIcon: 'spinner',
    label: 'In progress',
  }),
  [TODO_STATUS.COMPLETED]: Object.freeze({
    icon: '\u25CF',
    waIcon: 'circle-check',
    label: 'Completed',
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
