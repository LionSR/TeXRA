export type SessionTitleState = 'idle' | 'running' | 'approval';

/** Format the product title shared by native windows and terminal tabs. */
export function formatSessionTitle(
  project: string | undefined,
  state: SessionTitleState = 'idle',
): string {
  let activity: string | undefined;
  if (state === 'approval') activity = 'Approval needed';
  if (state === 'running') activity = 'Running';
  return ['TeXRA', activity, project || undefined]
    .filter((segment): segment is string => segment !== undefined)
    .join(' — ');
}
