import { Effect } from 'effect';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { readSettingFrom } from '@utils/config/platformSettings';

/**
 * Whether stopping or killing an agent stream should detach its active child
 * executions instead of letting them die with the parent.
 *
 * Read live at stop/kill time, from the settings slots of the session whose
 * run is being stopped, so a settings change takes effect immediately and a
 * process holding several papers answers for the right one.
 *
 * This owns the policy for the *configured* stop surfaces, in every host. Two
 * callers read it: the session request handler's `run.stop` arm, which
 * resolves a request that leaves `detachActiveChildren` unset (the extension
 * and desktop progress-view stream stop, the extension review-run stop, the
 * CLI root-run interrupt (Ctrl-C) and TUI kill action), and the orchestrator
 * `executions` kill tool, which kills through `Runs` directly because it
 * reports whether the kill was accepted. Two stop paths deliberately do not
 * consult it, and each declares an explicit value at its own call site
 * rather than reading a default:
 *
 * - Bare Escape in the CLI TUI is a focus-scoped gesture — "stop only the
 *   focused stream" — so `stopRun` always detaches descendants instead of
 *   cascading into runs the user never focused
 *   (`packages/cli/src/chat/chatSessionController.ts`, #9009).
 * - Headless CLI shutdown always cascades: a detached child cannot outlive the
 *   exiting process, so honoring the toggle there would strand children
 *   without finalization (`packages/cli/src/runtime/executeCli.ts`).
 *
 * Host quit is a separate axis this toggle does not govern, and detaching does
 * not opt a child out of it: `detachActiveChildren` detaches a child from its
 * parent without untracking its handle, so the shared exit drain
 * (`settleLiveSessionRuns`, #11355) still settles every tracked child on
 * the way out, on every host. The CLI additionally kills or interrupts them,
 * because the process that owns them is the one going away.
 *
 * The platform must be initialized before a run can be stopped or killed.
 */
export const detachSubagentsOnStop = Effect.fn('detachSubagentsOnStop')(
  function* (settings: SettingsStores) {
    return yield* readSettingFrom<boolean>(
      settings,
      GlobalStateKey.DETACH_SUBAGENTS_ON_STOP,
    );
  },
);
