import { tryPlatform } from '@platform/platform';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

/**
 * Whether stopping or killing an agent stream should detach its active child
 * executions instead of letting them die with the parent.
 *
 * Read live at stop/kill time so the desktop and extension settings toggle
 * takes effect immediately.
 *
 * The single production caller is `ExecutionRegistry`, which resolves this
 * whenever `ExecutionStopOptions.detachActiveChildren` is omitted. Hosts do
 * NOT call this and must not thread the result into a stop/kill call — that
 * arrangement is what let one CLI stop path hardcode `true` and silently
 * ignore the user's setting. Deciding it at the registry is what makes "one
 * source of truth" structurally true rather than a convention.
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
