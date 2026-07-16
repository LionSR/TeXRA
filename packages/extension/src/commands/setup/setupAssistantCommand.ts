// Third-party imports
import * as vscode from 'vscode';

// Local imports
import {
  resolveSetupLaunchModel,
  SETUP_INSTRUCTION,
} from '@controllers/onboarding/setupLaunch';
import { platform } from '@platform/platform';
import { loadAgents } from '@agent/index';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { runAgent } from '@agent/runtime/runAgent';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { AUTH_COMMANDS } from '@auth/constants';
import { apiKeyCommands } from '@commands/api/apiKeyCommands';
import { GlobalStateKey, globalSM } from '@common/state';
import { SecretManager } from '@frontend/secretManager';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { signInWithChatGptSubscription } from '@frontend/auth/codexSubscriptionSignIn';
import * as logger from '@logger/logUtils';
import { hasUsableSetupCredential } from '@model/setupCredentialAccess';
import {
  ONBOARDING_CHOICE_API_KEY,
  ONBOARDING_CHOICE_CHATGPT,
  ONBOARDING_CHOICE_SIGN_IN,
} from '@shared/copy/onboarding';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { agentName } from '@shared/schemas/agent';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { getUseOpenRouter } from '@utils/config/providerConfig';

const CHANNEL = 'SetupAssistant';
logger.initialize(CHANNEL);

interface LaunchModelResolution {
  model: string;
  requiresOpenRouter: boolean;
}

/**
 * The extension additionally offers the OpenRouter access-list model as a
 * last resort (`ensureRoutingConfigured` already prompted the user, so the
 * fallback's flag flip is expected, unlike desktop's silent-launch path).
 */
async function selectLaunchModel(): Promise<LaunchModelResolution | null> {
  const resolution = await resolveSetupLaunchModel(platform().secrets, true);
  if (!resolution) return null;
  return {
    model: resolution.model,
    requiresOpenRouter:
      resolution.reason === 'router-config' ||
      resolution.reason === 'access-list-default',
  };
}

/**
 * Temporarily flip `useOpenRouter` on for the OR-only launch path and always
 * restore it, including failures before `executeAgent` starts.
 */
async function withOpenRouterFlagOn<T>(fn: () => Promise<T>): Promise<T> {
  const prior = globalSM.get<boolean>(GlobalStateKey.USE_OPENROUTER) === true;
  if (prior) return fn();

  await globalSM.update(GlobalStateKey.USE_OPENROUTER, true);
  try {
    return await fn();
  } finally {
    await globalSM
      .update(GlobalStateKey.USE_OPENROUTER, false)
      .then(undefined, (err) => {
        logger.error(CHANNEL, 'Failed to restore useOpenRouter flag.', {
          data: err,
        });
      });
  }
}

/**
 * Pre-flight uses the shared host-neutral predicate (adapter-level checks, so
 * blank env keys do not count as credentials and then fail later as "No model
 * is available") so this host can't drift from desktop's credential gate. The
 * CLI has its own apiMode-aware policy and doesn't call this predicate — see
 * the note on `hasUsableSetupCredential`.
 */
export async function hasAnyUsableSetupCredential(): Promise<boolean> {
  return hasUsableSetupCredential(platform().secrets);
}

async function ensureCredentialOrPrompt(): Promise<boolean> {
  if (await hasAnyUsableSetupCredential()) return true;

  const picks = [
    {
      label: `$(comment-discussion) ${ONBOARDING_CHOICE_CHATGPT.label}`,
      description: ONBOARDING_CHOICE_CHATGPT.description,
      id: 'chatgpt' as const,
    },
    {
      label: `$(sign-in) ${ONBOARDING_CHOICE_SIGN_IN.label}`,
      description: ONBOARDING_CHOICE_SIGN_IN.description,
      id: 'signIn' as const,
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

  type CredentialPick = (typeof picks)[number];
  const picked = await vscode.window.showQuickPick<CredentialPick>(picks, {
    title: 'TeXRA Setup',
    placeHolder:
      'TeXRA needs a credential before the setup assistant can run models.',
    prompt:
      'ChatGPT uses your Plus/Pro subscription; Researcher Access uses your TeXRA account; API Key requires a provider key.',
  });

  if (!picked) return false;

  // Each credential path runs its action then re-checks for a usable
  // credential; only the walkthrough leaves setup un-launched.
  const credentialActions: Partial<
    Record<typeof picked.id, () => PromiseLike<unknown>>
  > = {
    chatgpt: () => signInWithChatGptSubscription(CHANNEL),
    signIn: () => vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_IN),
    apiKey: () => vscode.commands.executeCommand(apiKeyCommands.setApiKey),
  };

  const action = credentialActions[picked.id];
  if (action) {
    await action();
    return hasAnyUsableSetupCredential();
  }

  // walkthrough
  await vscode.commands.executeCommand('texra.openGettingStarted');
  return false;
}

// Routing is fine unless "Use OpenRouter" is on without an OpenRouter key.
async function isRoutingConfigured(): Promise<boolean> {
  if (!getUseOpenRouter()) return true;
  return SecretManager.hasUsableApiKey('openRouter');
}

/**
 * Refuse launch if "Use OpenRouter" is globally on but the user has no
 * OpenRouter key. In that configuration, every model call routes through
 * OpenRouter regardless of provider, and the setup agent (like any other
 * agent) will fail on a missing OR key. We ask the user to resolve the
 * misconfiguration explicitly — we deliberately don't flip the global
 * flag off for them, because a user who enabled OpenRouter did so on
 * purpose and may have concurrent OR-routed agents running.
 */
async function ensureRoutingConfigured(): Promise<boolean> {
  if (await isRoutingConfigured()) return true;

  const choice = await vscode.window.showWarningMessage(
    '"Use OpenRouter" is enabled in settings, but no OpenRouter key is set. Every model call routes through OpenRouter and will fail. Add an OpenRouter key, or disable "Use OpenRouter" in the Models tab, then retry.',
    { modal: true },
    'Open Models tab',
    'Add OpenRouter key',
  );
  if (choice === 'Open Models tab') {
    await vscode.commands.executeCommand('texra.showModels');
  } else if (choice === 'Add OpenRouter key') {
    await vscode.commands.executeCommand(apiKeyCommands.setApiKey);
  } else {
    return false;
  }
  // Re-check: the user may have resolved the misconfiguration (added an
  // OR key, or disabled Use OpenRouter in the Models tab), in which case
  // we can proceed without forcing them to re-invoke the command.
  return isRoutingConfigured();
}

export type SetupAssistantLaunchResult =
  'launched' | 'already-running' | 'not-started';

export async function launchSetupAssistant(): Promise<SetupAssistantLaunchResult> {
  try {
    // Every setup entry point funnels through here (command, status pill,
    // walkthrough, onboarding setup card), so one guard covers them all:
    // a second concurrent setup conversation would race the first one's
    // installs and config writes. The launcher's manual Execute path is
    // deliberately not gated — an explicit user action wins.
    if (
      defaultSession()
        .executions.getAgentHandles()
        .some((handle) => agentName(handle.agentName) === SETUP_AGENT_NAME)
    ) {
      void vscode.window.showInformationMessage(
        'The setup assistant is already running — follow it in the Progress view.',
      );
      await vscode.commands.executeCommand('texra.showProgressView');
      return 'already-running';
    }

    // Check routing configuration before credentials: a ChatGPT-
    // subscription user whose "Use OpenRouter" flag is on without an OR
    // key would otherwise fall into the credential prompt first because
    // isCodexSubscriptionActive returns false because
    // shouldUseCodexSubscription short-circuits when useOpenRouter is true.
    if (!(await ensureRoutingConfigured())) {
      void vscode.window.showInformationMessage(
        'Setup assistant cancelled. Resolve the "Use OpenRouter" configuration (add an OpenRouter key or disable the setting in Dashboard → Models), then run `TeXRA: Run Setup Assistant` again.',
      );
      return 'not-started';
    }

    const proceed = await ensureCredentialOrPrompt();
    if (!proceed) {
      void vscode.window.showInformationMessage(
        'Setup assistant cancelled. Run `TeXRA: Run Setup Assistant` again once you have signed in, enabled ChatGPT subscription, or set an API key.',
      );
      return 'not-started';
    }

    const resolution = await selectLaunchModel();
    if (!resolution) {
      // Edge case: signed in with Included Access but tier excludes every
      // setup-model candidate, and no direct/OR keys to fall back on.
      // Refuse launch rather than pick a model that crashes at runtime.
      const choice = await vscode.window.showWarningMessage(
        'No model is available for your current credentials and tier. Sign in with ChatGPT for Codex models, add a provider API key, or upgrade your Researcher Access tier, then retry.',
        { modal: true },
        'Open Models tab',
        'Set API key',
      );
      if (choice === 'Open Models tab') {
        await vscode.commands.executeCommand('texra.showModels');
      } else if (choice === 'Set API key') {
        await vscode.commands.executeCommand(apiKeyCommands.setApiKey);
      }
      return 'not-started';
    }

    const config = AgentConfigSchema.parse({
      agent: 'setup',
      agentCategory: 'toolUse',
      model: resolution.model,
      instruction: SETUP_INSTRUCTION,
    });

    // Activation initializes the registry, but this command can also be
    // invoked directly in tests or unusual startup paths. `loadAgents()` is
    // idempotent: it returns the in-flight promise if loading is still
    // running, resolves immediately if already initialized, or kicks off a
    // fresh load.
    await loadAgents();

    const launch = async () => {
      await runAgent(
        { config },
        {
          runtimeHost: extensionAgentRuntimeHost,
        },
      );
    };

    if (resolution.requiresOpenRouter) {
      await withOpenRouterFlagOn(launch);
    } else {
      await launch();
    }
    return 'launched';
  } catch (error) {
    logger.error(CHANNEL, 'Setup assistant failed to launch.', { data: error });
    void vscode.window.showErrorMessage(
      `Failed to launch setup assistant: ${toErrorMessage(error)}`,
    );
    return 'not-started';
  }
}
