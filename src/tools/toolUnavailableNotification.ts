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
import { EXTERNAL_TOOL_DEFS } from '@tools/externalToolDefs';

/** Groups already surfaced in a notification this session — avoids repeat popups. */
const notifiedGroupsBySession = new WeakMap<SessionHandle, Set<string>>();

const DEFAULT_ACTION_COMMAND = 'texra.showTools';
const DEFAULT_ACTION_LABEL = 'Open Tools Dashboard';

/** Info about an unavailable tool group, as surfaced by a notification. */
interface UnavailableGroupInfo {
  readonly name: string;
  readonly hideFromDashboard: boolean;
  /**
   * Command to execute when the user clicks the "fix this" button in the
   * notification. Overrides the default Tools-Dashboard action so groups
   * whose real configuration lives elsewhere (e.g. GitHub token in the Git
   * tab) can point the user to the right place.
   */
  readonly installActionCommand?: string;
  /** Label for the custom action button (falls back to a sensible default). */
  readonly installActionLabel?: string;
}

/**
 * Map a list of unavailable tool names to their group info
 * (e.g. `["lean_diagnostics", "lean_file"]` → `[{ name: "Lean 4 Proof Assistant", … }]`).
 * Returns deduplicated entries in definition order.
 */
function mapToolNamesToGroups(
  toolNames: readonly string[],
): UnavailableGroupInfo[] {
  const nameSet = new Set(toolNames);
  const seen = new Set<string>();
  const groups: UnavailableGroupInfo[] = [];
  for (const def of EXTERNAL_TOOL_DEFS) {
    if (seen.has(def.id)) continue;
    if (def.tools.some((t) => nameSet.has(t))) {
      seen.add(def.id);
      groups.push({
        name: def.name,
        hideFromDashboard: def.hideFromDashboard ?? false,
        installActionCommand: def.installActionCommand,
        installActionLabel: def.installActionLabel,
      });
    }
  }
  return groups;
}

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
  const hiddenNames = fresh
    .filter((g) => g.hideFromDashboard)
    .map((g) => g.name);
  if (hiddenNames.length > 0) {
    notify(formatExclusionMessage(hiddenNames));
  }

  // Coalesce dashboard-visible groups by their action target. Groups with
  // the default target share one toast; a group with an override (e.g.
  // github-pr-subscription → Git tab) gets its own.
  const byAction = new Map<
    string,
    { cmd: string; label: string; names: string[] }
  >();
  for (const g of fresh) {
    if (g.hideFromDashboard) continue;
    const cmd = g.installActionCommand ?? DEFAULT_ACTION_COMMAND;
    const label = g.installActionLabel ?? DEFAULT_ACTION_LABEL;
    const bucket = byAction.get(`${cmd}\0${label}`);
    if (bucket) bucket.names.push(g.name);
    else byAction.set(`${cmd}\0${label}`, { cmd, label, names: [g.name] });
  }
  for (const { cmd, label, names } of byAction.values()) {
    notify(formatExclusionMessage(names), cmd, label);
  }
}

function formatExclusionMessage(names: string[]): string {
  const quoted = names.map((n) => `"${n}"`).join(', ');
  return `${quoted} tools were excluded — external dependencies not installed.`;
}
