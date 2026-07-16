/**
 * Notification for unavailable external tools.
 *
 * Separated from the tool-use flow so the flow runner stays decoupled from
 * the host UI layer. The active session supplies the presentation adapter.
 */

import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { mapToolNamesToGroups } from '@tools/toolAvailability';

/** Groups already surfaced in a notification this session — avoids repeat popups. */
const notifiedGroupsBySession = new WeakMap<SessionHandle, Set<string>>();

const DEFAULT_ACTION_COMMAND = 'texra.showTools';
const DEFAULT_ACTION_LABEL = 'Open Tools Dashboard';

/**
 * Show notifications for tool groups excluded due to missing dependencies.
 *
 * Groups hidden from the Tools dashboard (e.g. TeXcount, surfaced in the
 * LaTeX settings tab instead) get a plain message — no action button —
 * because any generic dashboard link would point to the wrong place.
 *
 * Visible groups get an action button. By default it opens the Tools
 * dashboard, but a group can override via `installActionCommand` /
 * `installActionLabel` to route the user where the actual fix lives
 * (e.g. GitHub PR Activity Subscription points to the Git tab where the
 * token is configured).
 *
 * Groups that share the same action target (e.g. all the default
 * "Open Tools Dashboard" ones) are coalesced into a single toast so an
 * upgrading user with several unmet dependencies doesn't get flooded
 * with one popup per group.
 *
 * Each group is only notified once per session.
 */
export function notifyUnavailableTools(
  excludedToolNames: string[],
  session: SessionHandle = currentSession(),
): void {
  const notify = session.interactions.notifyUnavailableTools;
  if (!notify) return;

  let notifiedGroups = notifiedGroupsBySession.get(session);
  if (!notifiedGroups) {
    notifiedGroups = new Set<string>();
    notifiedGroupsBySession.set(session, notifiedGroups);
  }
  const groups = mapToolNamesToGroups(excludedToolNames);
  const fresh = groups.filter((g) => !notifiedGroups.has(g.name));
  if (fresh.length === 0) return;
  for (const g of fresh) notifiedGroups.add(g.name);

  // Coalesce hidden-from-dashboard groups (no action).
  const hiddenGroups = fresh.filter((g) => g.hideFromDashboard);
  if (hiddenGroups.length > 0) {
    const label = formatGroupLabel(hiddenGroups.map((g) => g.name));
    notify(`${label} excluded — external dependencies not installed.`);
  }

  // Coalesce dashboard-visible groups by their action target. Groups with
  // the default target share one toast; a group with an override (e.g.
  // github-pr-subscription → Git tab) gets its own.
  const byAction = new Map<string, typeof fresh>();
  for (const g of fresh) {
    if (g.hideFromDashboard) continue;
    const cmd = g.installActionCommand ?? DEFAULT_ACTION_COMMAND;
    const label = g.installActionLabel ?? DEFAULT_ACTION_LABEL;
    const bucketKey = `${cmd}\0${label}`;
    const bucket = byAction.get(bucketKey);
    if (bucket) bucket.push(g);
    else byAction.set(bucketKey, [g]);
  }
  for (const [bucketKey, bucket] of byAction) {
    const [cmd, label] = bucketKey.split('\0');
    const names = formatGroupLabel(bucket.map((g) => g.name));
    notify(
      `${names} excluded — external dependencies not installed.`,
      cmd,
      label,
    );
  }
}

function formatGroupLabel(names: string[]): string {
  return names.length === 1
    ? `"${names[0]}" tools were`
    : `${names.map((n) => `"${n}"`).join(', ')} tools were`;
}
