export type SessionTitleState = 'idle' | 'running' | 'approval';

const ACTIVITY_LABEL: Record<SessionTitleState, string | undefined> = {
  idle: undefined,
  running: 'Running',
  approval: 'Approval needed',
};

/**
 * Format the product title shared by native windows and terminal tabs.
 * Optional `activityDetail` appends to the state label (e.g. a spinner frame
 * for the running state) without string-splicing the final title.
 */
export function formatSessionTitle(
  project: string | undefined,
  state: SessionTitleState,
  activityDetail?: string,
): string {
  const label = ACTIVITY_LABEL[state];
  let activity = label;
  if (label != null && activityDetail) {
    activity = `${label} ${activityDetail}`;
  }
  return ['TeXRA', activity, project]
    .filter((segment): segment is string => Boolean(segment))
    .join(' — ');
}
