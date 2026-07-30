export type SessionTitleState = 'idle' | 'running' | 'approval';

const ACTIVITY_LABEL: Record<SessionTitleState, string | undefined> = {
  idle: undefined,
  running: 'Running',
  approval: 'Approval needed',
};

/** Format the product title shared by native windows and terminal tabs. */
export function formatSessionTitle(
  project: string | undefined,
  state: SessionTitleState = 'idle',
): string {
  return ['TeXRA', ACTIVITY_LABEL[state], project]
    .filter((segment): segment is string => Boolean(segment))
    .join(' — ');
}
