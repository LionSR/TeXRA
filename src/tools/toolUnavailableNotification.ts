/**
 * Notification for unavailable external tools.
 *
 * Separated from the tool-use flow so the flow runner stays decoupled from
 * the host UI layer. The notification callback is injected at activation.
 */

import { mapToolNamesToGroups } from '@tools/toolAvailability';

/** Groups already surfaced in a notification this session — avoids repeat popups. */
const notifiedGroups = new Set<string>();

/**
 * Pluggable notification handler for unavailable tools.
 * Set by the extension host at activation; defaults to no-op.
 *
 * `actionCommand` and `actionLabel` let a notification funnel the user to the
 * right tab — e.g. the Git tab for the GitHub token rather than the generic
 * Tools dashboard.
 */
let notificationHandler: (
  message: string,
  actionCommand?: string,
  actionLabel?: string,
) => void = () => {};

/** Register a platform-specific notification handler. */
export function setToolNotificationHandler(
  handler: (
    message: string,
    actionCommand?: string,
    actionLabel?: string,
  ) => void,
): void {
  notificationHandler = handler;
}

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
 * Each group is only notified once per session.
 */
export function notifyUnavailableTools(excludedToolNames: string[]): void {
  const groups = mapToolNamesToGroups(excludedToolNames);
  const fresh = groups.filter((g) => !notifiedGroups.has(g.name));
  if (fresh.length === 0) return;
  for (const g of fresh) notifiedGroups.add(g.name);

  for (const g of fresh) {
    const label = formatGroupLabel([g.name]);
    const message = `${label} excluded — external dependencies not installed.`;
    if (g.hideFromDashboard) {
      notificationHandler(message);
    } else {
      notificationHandler(
        message,
        g.installActionCommand ?? DEFAULT_ACTION_COMMAND,
        g.installActionLabel ?? DEFAULT_ACTION_LABEL,
      );
    }
  }
}

function formatGroupLabel(names: string[]): string {
  return names.length === 1
    ? `"${names[0]}" tools were`
    : `${names.map((n) => `"${n}"`).join(', ')} tools were`;
}
