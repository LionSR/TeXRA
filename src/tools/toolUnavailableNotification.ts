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
 */
let notificationHandler: (
  message: string,
  actionCommand?: string,
) => void = () => {};

/** Register a platform-specific notification handler. */
export function setToolNotificationHandler(
  handler: (message: string, actionCommand?: string) => void,
): void {
  notificationHandler = handler;
}

/**
 * Show notifications for tool groups excluded due to missing dependencies.
 *
 * Groups visible on the Tools dashboard get an "Open Tools Dashboard" button.
 * Groups hidden from the dashboard (e.g. TeXcount, shown in LaTeX settings
 * instead) get a plain message — no misleading dashboard link.
 *
 * Each group is only notified once per session.
 */
export function notifyUnavailableTools(excludedToolNames: string[]): void {
  const groups = mapToolNamesToGroups(excludedToolNames);
  const fresh = groups.filter((g) => !notifiedGroups.has(g.name));
  if (fresh.length === 0) return;
  for (const g of fresh) notifiedGroups.add(g.name);

  const dashboardGroups = fresh.filter((g) => !g.hideFromDashboard);
  const hiddenGroups = fresh.filter((g) => g.hideFromDashboard);

  if (dashboardGroups.length > 0) {
    const label = formatGroupLabel(dashboardGroups.map((g) => g.name));
    notificationHandler(
      `${label} excluded — external dependencies not installed.`,
      'texra.showTools',
    );
  }

  if (hiddenGroups.length > 0) {
    const label = formatGroupLabel(hiddenGroups.map((g) => g.name));
    notificationHandler(
      `${label} excluded — external dependencies not installed.`,
    );
  }
}

function formatGroupLabel(names: string[]): string {
  return names.length === 1
    ? `"${names[0]}" tools were`
    : `${names.map((n) => `"${n}"`).join(', ')} tools were`;
}
