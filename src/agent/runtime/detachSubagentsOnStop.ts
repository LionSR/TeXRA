import { platform } from '@platform/platform';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

/**
 * Whether stopping or killing an agent stream should detach its active child
 * executions instead of letting them die with the parent.
 *
 * Read live at stop/kill time so a settings change takes effect immediately.
 *
 * This owns the policy for the *configured* stop surfaces, in every host: the
 * extension stop command and review-run stop, the desktop stream stop, the CLI
 * root-run interrupt (Ctrl-C) and TUI kill action, and the orchestrator
 * `executions` kill tool. Two stop paths deliberately do not consult it, and
 * each declares that at its own call site rather than reading a default:
 *
 * - Bare Escape in the CLI TUI is a focus-scoped gesture — "stop only the
 *   focused stream" — so `stopStream` always detaches descendants instead of
 *   cascading into streams the user never focused
 *   (`packages/cli/src/chat/chatSessionController.ts`, #9009).
 * - Headless CLI shutdown always cascades: a detached child cannot outlive the
 *   exiting process, so honoring the toggle there would strand children
 *   without finalization (`packages/cli/src/runtime/runExecution.ts`).
 *
 * Host quit is a separate axis this toggle does not govern. The extension and
 * desktop abandon native children to the restart-repair path; the CLI kills or
 * interrupts them, because the process that owns them is the one going away.
 *
 * The platform must be initialized before a run can be stopped or killed.
 */
export function detachSubagentsOnStop(): boolean {
  // `get<boolean>` casts rather than coerces, so a hand-edited `1` or "true"
  // in the persisted state would otherwise escape as a non-boolean.
  return (
    platform().workspaceState.get<boolean>(
      WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
      false,
    ) === true
  );
}
