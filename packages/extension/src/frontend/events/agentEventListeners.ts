/**
 * Frontend handlers for presentation events emitted by agent core/runtime.
 *
 * These bridge the gap between the agent layer (which must not import from
 * @frontend/) and the VS Code UI. `createAgentPresentationHost` builds the
 * presentation host `ProgressViewProvider` attaches to the session; this
 * module performs the actual UI operations for each event. Every handler
 * answers with the program that presents its event: the session's
 * presentation layer forks it and reports its failure, so nothing here runs
 * a fiber of its own.
 */
import { Effect } from 'effect';

import {
  withProcessServices,
  type ProcessRuntime,
} from '@texra-ai/harness/host';
import { withLogChannel } from '@texra-ai/harness/plugins';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { setApiKey } from '@commands/api/apiKeyCommands';
import { openGuidePage } from '@frontend/hosts/VscodeExternalOpener';
import { askNotice } from '@frontend/hosts/VscodeUiHost';
import type { ShowBuilt } from '@frontend/latex/openBuild';
import type { GuiWindowHost } from '@texra/controllers/session/openGuiWindow';
import { windowNotices } from '@texra/controllers/session/windowNotices';
import type { WorkspaceRoots } from '@texra-ai/harness';

const CHANNEL = 'agentEventListeners';

/** Warn-log a step whose failure is a diagnostic rather than non-delivery,
 *  and carry on with the step after it. */
export function warnOnFailure<E>(
  program: Effect.Effect<void, E>,
  what: string,
): Effect.Effect<void> {
  return program.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`${what}: ${toErrorMessage(cause)}`).pipe(
        withLogChannel(CHANNEL),
      ),
    ),
  );
}

/**
 * The runtime's notices this extension presents its own way; the window's
 * opening adds the missing-agent banner. The session's `Interactions` (the
 * runtime) owns replaying an event emitted before this host attaches.
 */
export function createAgentPresentationHost(
  roots: WorkspaceRoots,
  runtime: ProcessRuntime,
  showBuilt: ShowBuilt,
): GuiWindowHost['notices'] {
  return {
    // The open-and-build program takes this window's file services from the
    // runtime's context, which the session that forks it does not carry.
    openFile: (payload) =>
      withProcessServices(
        runtime,
        showBuilt([payload.location], {
          preserveFocus: payload.preserveFocus,
        }),
      ),
    ...windowNotices({
      ask: askNotice,
      setApiKey: withProcessServices(runtime, setApiKey(roots)),
      openGuide: openGuidePage,
      globalState: roots.globalState,
    }),
  };
}
