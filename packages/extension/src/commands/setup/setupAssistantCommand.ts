// Third-party imports
import { Settings } from '@texra-ai/harness';
import { Cause, Effect } from 'effect';

// Local imports
import { AgentConfigSchema } from '@texra-ai/harness/schemas';
import { withLogChannel } from '@texra-ai/harness';
import { isLiveRun } from '@texra-ai/harness/schemas';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { GlobalStateKey } from '@texra-ai/harness/schemas';
import { EXTENSION_COMMANDS } from '@commands/extensionCommandIds';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import {
  announce,
  showLoggedInfoMessage,
} from '@frontend/ui/errorHandlingUtils';
import { agentName, type RunId } from '@shared/schemas';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { SETUP_INSTRUCTION } from '@texra/controllers/onboarding/setupLaunch';
import { resolveSetupLaunchModel } from '@texra/model/setupCredentialAccess';
import type { ProcessServices, Session } from '@texra-ai/harness';
import type {
  PlatformSecrets,
  StateReadFailed,
  StateWriteFailed,
} from '@texra-ai/harness';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { SettingsStores } from '@texra-ai/harness';

/** The setup assistant's log channel, for its launch and what follows it. */
export const SETUP_ASSISTANT_CHANNEL = 'SetupAssistant';
const CHANNEL = SETUP_ASSISTANT_CHANNEL;
/**
 * Temporarily flip `useOpenRouter` on for the OR-only launch path and always
 * restore it, including failures before `executeAgent` starts. The flip is the
 * acquisition of an `Effect.acquireUseRelease`, so it is uninterruptible: a
 * runtime disposal landing while the enabling write is in flight cannot let
 * the restore run against an outstanding write and leave the flag on. The
 * restore is the release, so it runs on every exit, interruption included, and
 * only after the write it undoes has committed.
 */
function withOpenRouterFlagOn<A, E, R>(
  stores: SettingsStores,
  program: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | StateReadFailed, R> {
  const { globalState } = stores;
  return Effect.gen(function* () {
    if (yield* Settings.get<boolean>(stores, GlobalStateKey.USE_OPENROUTER))
      return yield* program;

    return yield* Effect.acquireUseRelease(
      // The acquisition's failure is the launch's own, and it is uninterruptible
      // here — so it dies with the program that could not start rather than
      // joining an error channel the caller does not carry.
      globalState
        .update(GlobalStateKey.USE_OPENROUTER, true)
        .pipe(Effect.orDie),
      () => program,
      () =>
        // The restore write's own failure never leaves this module: the
        // finalizer logs it and continues, so a failed restore never masks the
        // launch's own outcome. The handler names the whole channel, so a
        // widened one fails to compile rather than escaping unlogged.
        globalState
          .update(GlobalStateKey.USE_OPENROUTER, false)
          .pipe(
            Effect.catch((error: StateWriteFailed) =>
              Effect.logError('Failed to restore useOpenRouter flag.').pipe(
                Effect.annotateLogs({ data: error }),
                withLogChannel(CHANNEL),
              ),
            ),
          ),
    );
  });
}

// Routing is fine when the current configuration resolves any setup model.
// A managed direct route can remain runnable even when global OpenRouter is
// enabled without an OpenRouter key.
function isRoutingConfigured(stores: SettingsStores, secrets: PlatformSecrets) {
  return Effect.gen(function* () {
    if (!(yield* Settings.get<boolean>(stores, GlobalStateKey.USE_OPENROUTER)))
      return true;
    return (yield* resolveSetupLaunchModel(stores, secrets, false)) !== null;
  });
}

/**
 * Refuse launch if "Use OpenRouter" is globally on but neither an OpenRouter
 * key nor a managed direct setup credential can run. We ask the user to
 * resolve the misconfiguration explicitly rather than flipping the global
 * flag, because concurrent OpenRouter-routed agents may rely on it.
 */
const ensureRoutingConfigured = Effect.fn('ensureRoutingConfigured')(function* (
  stores: SettingsStores,
  secrets: PlatformSecrets,
) {
  if (yield* isRoutingConfigured(stores, secrets)) return true;

  const choice = yield* vscodeUi.warning(
    '"Use OpenRouter" is on, but there is no OpenRouter key and no other provider TeXRA can reach. Add an OpenRouter key, or turn off "Use OpenRouter" in the Models tab, then try again.',
    { modal: true, items: ['Open Models tab', 'Add OpenRouter key'] },
  );
  if (choice === 'Open Models tab') {
    yield* safeExecuteCommand('texra.showDashboard', ['models/keys'], CHANNEL);
  } else if (choice === 'Add OpenRouter key') {
    yield* safeExecuteCommand(EXTENSION_COMMANDS.SET_API_KEY, [], CHANNEL);
  } else {
    return false;
  }
  // Re-check: the user may have resolved the misconfiguration (added an
  // OR key, or disabled Use OpenRouter in the Models tab), in which case
  // we can proceed without forcing them to re-invoke the command.
  return yield* isRoutingConfigured(stores, secrets);
});

/**
 * The launch program the command surface runs on the process runtime: it
 * folds every failure — a failed host call, a failed model resolution, a
 * failed root launch — into one error report and a `not-started` result,
 * which is the contract its host caller relies on. An interrupted launch is
 * not a failure: the cause is re-raised so a runtime disposal stays a
 * cancellation instead of a launch-failure notice.
 */
export function launchSetupAssistant(
  secrets: PlatformSecrets,
  roots: WorkspaceRoots,
  /** Where the setup conversation runs: here, or in the service. */
  runSession: Session,
  onAdmitted: (runId: RunId) => Effect.Effect<void, Error>,
  /** Bring the panel's "Connect a model" card into view: the one credential
   *  prompt, which the setup card follows once a credential lands. */
  connectModel: Effect.Effect<void, Error, ProcessServices>,
) {
  return Effect.gen(function* () {
    // Every setup entry point funnels through here (command, status pill,
    // walkthrough, onboarding setup card), so one guard covers them all:
    // a second concurrent setup conversation would race the first one's
    // installs and config writes. The launcher's manual Execute path is
    // deliberately not gated — an explicit user action wins.
    const running = runSession.view.current().runs.values();
    if (
      [...running].some(
        (run) =>
          isLiveRun(run) &&
          run.identity.kind === 'agent' &&
          agentName(run.identity.agent) === SETUP_AGENT_NAME,
      )
    ) {
      yield* Effect.forkDetach(
        showLoggedInfoMessage(
          CHANNEL,
          'The setup assistant is already running. Follow it in the TeXRA panel.',
        ),
      );
      yield* safeExecuteCommand('texra.showProgressView', [], CHANNEL);
      return 'already-running' as const;
    }

    // Check routing configuration before credentials: a ChatGPT-
    // subscription user whose "Use OpenRouter" flag is on without an OR
    // key would otherwise fall into the credential prompt first, because the
    // picker never routes through the subscription while OpenRouter is on.
    if (!(yield* ensureRoutingConfigured(roots, secrets))) {
      yield* Effect.forkDetach(
        showLoggedInfoMessage(
          CHANNEL,
          'Setup assistant cancelled. Fix the "Use OpenRouter" setting in Settings → Models, then run `TeXRA: Run Setup Assistant` again.',
        ),
      );
      return 'not-started' as const;
    }

    // The launch model the credential predicate every host shares decides:
    // adapter-level checks, so a blank env key does not count and fail later
    // as "No model is available". No model is the missing-credential case; a
    // check that cannot be answered fails to the launch-failure report below.
    const resolution = yield* resolveSetupLaunchModel(roots, secrets, true);
    if (!resolution) {
      yield* connectModel;
      return 'not-started' as const;
    }

    const config = AgentConfigSchema.parse({
      agent: 'setup',
      model: resolution.model,
      instruction: SETUP_INSTRUCTION,
    });

    // The conversation, from its start through its end: the OpenRouter
    // flag it asked for holds until then. A failure once it started is its
    // result row's to show, not a failure to launch.
    const launch = runSession.start({ config, interactive: true }).pipe(
      Effect.tap((run) => onAdmitted(run.runId)),
      Effect.flatMap((run) =>
        run.result.pipe(
          Effect.asVoid,
          Effect.catch((failure) =>
            Effect.logDebug(`The setup run failed: ${failure.message}`),
          ),
        ),
      ),
    );

    yield* resolution.requiresOpenRouter
      ? withOpenRouterFlagOn(roots, launch)
      : launch;
    return 'launched' as const;
  }).pipe(
    Effect.catchCause((cause) => {
      // Shutdown interrupts this fiber while it waits on a host prompt.
      // That is a cancellation, not a launch failure: re-raise it so no
      // error notification appears during teardown.
      if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
      const error = Cause.squash(cause);
      return Effect.logError('Setup assistant failed to launch.').pipe(
        Effect.annotateLogs({ data: error }),
        withLogChannel(CHANNEL),
        Effect.andThen(
          Effect.forkDetach(
            announce(
              CHANNEL,
              vscodeUi.showErrorMessage(
                `Failed to launch setup assistant: ${toErrorMessage(error)}`,
              ),
              undefined,
            ),
          ),
        ),
        Effect.as('not-started' as const),
      );
    }),
  );
}
