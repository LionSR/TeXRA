// Third-party imports
import { Cause, Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { loadAgents } from '@agent/index';
import {
  AgentConfigSchema,
  runAgent,
  type SessionHandle,
} from '@agent/runtime';
import { EXTENSION_COMMANDS } from '@commands/extensionCommandIds';
import {
  resolveSetupLaunchModel,
  SETUP_INSTRUCTION,
} from '@controllers/onboarding/setupLaunch';
import { signInWithSubscription } from '@frontend/auth/subscriptionSignIn';
import { createLog } from '@logger/logUtils';
import { hasUsableSetupCredential } from '@model/setupCredentialAccess';
import type { StateStore, StateWriteFailed } from '@platform/interfaces';
import type { LanguageModel } from '@platform/languageModel';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import { presentLaunchedProgressRun } from '@progressView/progressNavigation';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { agentName } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import {
  ONBOARDING_CHOICE_API_KEY,
  ONBOARDING_CHOICE_CHATGPT,
} from '@shared/copy/onboarding';
import { getUseOpenRouter } from '@utils/config/providerConfig';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'SetupAssistant';
const log = createLog(CHANNEL);
const credentialLog = createLog('Setup Credentials');

interface LaunchModelResolution {
  model: string;
  requiresOpenRouter: boolean;
}

/**
 * The extension additionally offers the OpenRouter access-list model as a
 * last resort (`ensureRoutingConfigured` already prompted the user, so the
 * fallback's flag flip is expected, unlike desktop's silent-launch path).
 */
function selectLaunchModel(
  stores: SettingsStores,
  secrets: PlatformSecrets,
): Effect.Effect<LaunchModelResolution | null, never, LanguageModel> {
  return resolveSetupLaunchModel(stores, secrets, true).pipe(
    Effect.map((resolution) =>
      resolution
        ? {
            model: resolution.model,
            requiresOpenRouter:
              resolution.reason === 'router-config' ||
              resolution.reason === 'access-list-default',
          }
        : null,
    ),
  );
}

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
  globalState: StateStore,
  program: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  const prior =
    globalState.get<boolean>(GlobalStateKey.USE_OPENROUTER) === true;
  if (prior) return program;

  return Effect.acquireUseRelease(
    // The acquisition's failure is the launch's own, and it is uninterruptible
    // here — so it dies with the program that could not start rather than
    // joining an error channel the caller does not carry.
    globalState.update(GlobalStateKey.USE_OPENROUTER, true).pipe(Effect.orDie),
    () => program,
    () =>
      // The restore write's own failure never leaves this module: the
      // finalizer logs it and continues, so a failed restore never masks the
      // launch's own outcome. The handler names the whole channel, so a
      // widened one fails to compile rather than escaping unlogged.
      globalState.update(GlobalStateKey.USE_OPENROUTER, false).pipe(
        Effect.catch((error: StateWriteFailed) =>
          Effect.sync(() => {
            log.error('Failed to restore useOpenRouter flag.', { data: error });
          }),
        ),
      ),
  );
}

/**
 * Pre-flight uses the credential predicate shared by CLI, extension, and
 * desktop (adapter-level checks, so blank env keys do not count as credentials
 * and then fail later as "No model is available"). Host-specific setup launch
 * routing belongs to `resolveSetupLaunchModel`.
 */
export function hasAnyUsableSetupCredential(
  stores: SettingsStores,
  secrets: PlatformSecrets,
): Effect.Effect<boolean, never, LanguageModel> {
  return hasUsableSetupCredential(stores, secrets, credentialLog.warn);
}

const ensureCredentialOrPrompt = Effect.fn('ensureCredentialOrPrompt')(
  function* (
    stores: SettingsStores,
    secrets: PlatformSecrets,
    runtime: ProcessRuntime,
  ) {
    if (yield* hasAnyUsableSetupCredential(stores, secrets)) {
      return true;
    }

    const picks = [
      {
        label: `$(comment-discussion) ${ONBOARDING_CHOICE_CHATGPT.label}`,
        description: ONBOARDING_CHOICE_CHATGPT.description,
        id: 'chatgpt' as const,
      },
      {
        label: `$(key) ${ONBOARDING_CHOICE_API_KEY.label}`,
        description: ONBOARDING_CHOICE_API_KEY.description,
        id: 'apiKey' as const,
      },
      {
        label: '$(book) Open the manual walkthrough instead',
        description: 'Step through the Getting Started guide yourself',
        id: 'walkthrough' as const,
      },
    ];

    // Each option already carries its own description, so the picker needs no
    // second explanation of the same three choices.
    const picked = yield* Effect.promise(() =>
      vscode.window.showQuickPick(picks, {
        title: 'TeXRA setup',
        placeHolder:
          'Choose how the setup assistant reaches models before it starts.',
      }),
    );

    if (!picked) return false;

    // Each credential path runs its action then re-checks for a usable
    // credential; only the walkthrough leaves setup un-launched.
    switch (picked.id) {
      case 'chatgpt':
        yield* signInWithSubscription(stores, CHANNEL, 'chatgpt', runtime);
        break;
      case 'apiKey':
        yield* Effect.promise(() =>
          vscode.commands.executeCommand(EXTENSION_COMMANDS.SET_API_KEY),
        );
        break;
      case 'walkthrough':
        yield* Effect.promise(() =>
          vscode.commands.executeCommand(
            EXTENSION_COMMANDS.OPEN_GETTING_STARTED,
          ),
        );
        return false;
    }

    return yield* hasAnyUsableSetupCredential(stores, secrets);
  },
);

// Routing is fine when the current configuration resolves any setup model.
// A managed direct route can remain runnable even when global OpenRouter is
// enabled without an OpenRouter key.
function isRoutingConfigured(
  stores: SettingsStores,
  secrets: PlatformSecrets,
): Effect.Effect<boolean, never, LanguageModel> {
  if (!getUseOpenRouter(stores)) return Effect.succeed(true);
  return resolveSetupLaunchModel(stores, secrets, false).pipe(
    Effect.map((resolution) => resolution !== null),
  );
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

  const choice = yield* Effect.promise(() =>
    vscode.window.showWarningMessage(
      '"Use OpenRouter" is on, but there is no OpenRouter key and no other provider TeXRA can reach. Add an OpenRouter key, or turn off "Use OpenRouter" in the Models tab, then try again.',
      { modal: true },
      'Open Models tab',
      'Add OpenRouter key',
    ),
  );
  if (choice === 'Open Models tab') {
    yield* Effect.promise(() =>
      vscode.commands.executeCommand('texra.showModels'),
    );
  } else if (choice === 'Add OpenRouter key') {
    yield* Effect.promise(() =>
      vscode.commands.executeCommand(EXTENSION_COMMANDS.SET_API_KEY),
    );
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
 * failed `runAgent` — into one error report and a `not-started` result,
 * which is the contract its host caller relies on. An interrupted launch is
 * not a failure: the cause is re-raised so a runtime disposal stays a
 * cancellation instead of a launch-failure notice.
 */
export function launchSetupAssistant(
  secrets: PlatformSecrets,
  globalState: StateStore,
  runtime: ProcessRuntime,
  session: SessionHandle,
) {
  return Effect.gen(function* () {
    // Every setup entry point funnels through here (command, status pill,
    // walkthrough, onboarding setup card), so one guard covers them all:
    // a second concurrent setup conversation would race the first one's
    // installs and config writes. The launcher's manual Execute path is
    // deliberately not gated — an explicit user action wins.
    if (
      session.runs
        .getAgentHandles()
        .some((handle) => agentName(handle.agentName) === SETUP_AGENT_NAME)
    ) {
      void vscode.window.showInformationMessage(
        'The setup assistant is already running. Follow it in the Progress view.',
      );
      yield* Effect.promise(() =>
        vscode.commands.executeCommand('texra.showProgressView'),
      );
      return 'already-running' as const;
    }

    // Check routing configuration before credentials: a ChatGPT-
    // subscription user whose "Use OpenRouter" flag is on without an OR
    // key would otherwise fall into the credential prompt first because
    // isCodexSubscriptionActive returns false because
    // shouldUseCodexSubscription short-circuits when useOpenRouter is true.
    if (!(yield* ensureRoutingConfigured(session.roots, secrets))) {
      void vscode.window.showInformationMessage(
        'Setup assistant cancelled. Fix the "Use OpenRouter" setting in Dashboard → Models, then run `TeXRA: Run Setup Assistant` again.',
      );
      return 'not-started' as const;
    }

    const proceed = yield* ensureCredentialOrPrompt(
      session.roots,
      secrets,
      runtime,
    );
    if (!proceed) {
      void vscode.window.showInformationMessage(
        'Setup assistant cancelled. Run `TeXRA: Run Setup Assistant` again once you have signed in, turned on your ChatGPT subscription, or set an API key.',
      );
      return 'not-started' as const;
    }

    const resolution = yield* selectLaunchModel(session.roots, secrets);
    if (!resolution) {
      // Edge case: no setup-model candidate is usable with the current
      // credentials. Refuse launch rather than pick a model that crashes at
      // runtime.
      const choice = yield* Effect.promise(() =>
        vscode.window.showWarningMessage(
          'No model is available with your current keys. Add a provider API key or sign in with your ChatGPT subscription, then try again.',
          { modal: true },
          'Open Models tab',
          'Set API key',
        ),
      );
      if (choice === 'Open Models tab') {
        yield* Effect.promise(() =>
          vscode.commands.executeCommand('texra.showModels'),
        );
      } else if (choice === 'Set API key') {
        yield* Effect.promise(() =>
          vscode.commands.executeCommand(EXTENSION_COMMANDS.SET_API_KEY),
        );
      }
      return 'not-started' as const;
    }

    const config = AgentConfigSchema.parse({
      agent: 'setup',
      agentCategory: 'toolUse',
      model: resolution.model,
      instruction: SETUP_INSTRUCTION,
    });

    // Activation initializes the registry, but this command can also be
    // invoked directly in tests or unusual startup paths. `loadAgents()` is
    // idempotent: it joins the in-flight load through the catalog lane if one
    // is running, returns immediately if already initialized, or kicks off a
    // fresh load.
    yield* loadAgents();

    const launch = runAgent(
      { kind: 'fresh', config },
      {
        session,
        onRunResolved: presentLaunchedProgressRun,
      },
    );

    yield* resolution.requiresOpenRouter
      ? withOpenRouterFlagOn(globalState, launch)
      : launch;
    return 'launched' as const;
  }).pipe(
    Effect.catchCause((cause) => {
      // Shutdown interrupts this fiber while it waits on a host prompt.
      // That is a cancellation, not a launch failure: re-raise it so no
      // error notification appears during teardown.
      if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
      return Effect.sync(() => {
        const error = Cause.squash(cause);
        log.error('Setup assistant failed to launch.', { data: error });
        void vscode.window.showErrorMessage(
          `Failed to launch setup assistant: ${toErrorMessage(error)}`,
        );
        return 'not-started' as const;
      });
    }),
  );
}
