export type SessionTitleState = 'idle' | 'running' | 'approval';

const ACTIVITY_LABEL: Record<SessionTitleState, string | undefined> = {
  idle: undefined,
  running: 'Running',
  approval: 'Approval needed',
};

/**
 * Format the product title shared by native windows and terminal tabs.
 * Optional `activityDetail` (e.g. a live spinner frame) REPLACES the state
 * label for the running state — an animated frame already says "running",
 * so `TeXRA — ⠋ — proj` instead of `TeXRA — Running ⠋ — proj`; the label
 * stays when there is no live detail to carry it.
 */
export function formatSessionTitle(
  project: string | undefined,
  state: SessionTitleState,
  activityDetail?: string,
): string {
  const label = ACTIVITY_LABEL[state];
  let activity = label;
  if (state === 'running' && activityDetail) {
    // A live spinner frame already says "running"; no redundant word.
    activity = activityDetail;
  } else if (label != null && activityDetail) {
    activity = `${label} ${activityDetail}`;
  }
  return ['TeXRA', activity, project]
    .filter((segment): segment is string => Boolean(segment))
    .join(' — ');
}
