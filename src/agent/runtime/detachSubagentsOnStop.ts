import { platform } from '@platform/platform';
import { warnAbandonedSlotValue } from '@shared/config/settingsAccess';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { readPlatformSetting } from '@utils/config/platformSettings';

/**
 * Whether stopping or killing an agent stream should detach its active child
 * executions instead of letting them die with the parent.
 *
 * Read live at stop/kill time so a settings change takes effect immediately.
 *
 * This owns the policy for the *configured* stop surfaces, in every host: the
 * extension and desktop progress-view stream stop, the extension review-run
 * stop, the CLI root-run interrupt (Ctrl-C) and TUI kill action, and the
 * orchestrator `executions` kill tool. Two stop paths deliberately do not
 * consult it, and each declares that at its own call site rather than reading
 * a default:
 *
 * - Bare Escape in the CLI TUI is a focus-scoped gesture — "stop only the
 *   focused stream" — so `stopStream` always detaches descendants instead of
 *   cascading into streams the user never focused
 *   (`packages/cli/src/chat/chatSessionController.ts`, #9009).
 * - Headless CLI shutdown always cascades: a detached child cannot outlive the
 *   exiting process, so honoring the toggle there would strand children
 *   without finalization (`packages/cli/src/runtime/runExecution.ts`).
 *
 * Host quit is a separate axis this toggle does not govern, and detaching does
 * not opt a child out of it: `detachActiveChildren` detaches a child from its
 * parent without untracking its handle, so the shared exit drain
 * (`settleLiveSessionExecutions`, #11355) still settles every tracked child on
 * the way out, on every host. The CLI additionally kills or interrupts them,
 * because the process that owns them is the one going away.
 *
 * The platform must be initialized before a run can be stopped or killed.
 */
export function detachSubagentsOnStop(): boolean {
  warnAbandonedSlotValue(
    GlobalStateKey.DETACH_SUBAGENTS_ON_STOP,
    'workspaceState',
    platform().workspaceState,
  );
  return readPlatformSetting<boolean>(GlobalStateKey.DETACH_SUBAGENTS_ON_STOP);
}
