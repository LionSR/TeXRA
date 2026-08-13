import { tryPlatform } from '@platform/platform';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

/**
 * Whether stopping or killing an agent stream should detach its active child
 * executions instead of letting them die with the parent.
 *
 * Read live at stop/kill time so the desktop and extension settings toggle
 * takes effect immediately, and shared by every host (extension stop command,
 * desktop execution, CLI session controller and TUI kill, and the orchestrator
 * kill tool) so the `detachActiveChildren` policy has one source of truth.
 *
 * Uses `tryPlatform()` and the `=== true` coercion so the policy defaults to
 * false when the toggle is unset or the platform has not been initialized,
 * matching the previous inline reads at every call site.
 */
export function detachSubagentsOnStop(): boolean {
  return (
    tryPlatform()?.workspaceState.get<boolean>(
      WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
      false,
    ) === true
  );
}
