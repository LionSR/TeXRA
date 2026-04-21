// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { AgentConfigSchema } from '@agent/core';
import { registerExecution } from '@agent/storage';
import { executeAgent } from '@agent/runtime/executeAgent';
import { AUTH_COMMANDS } from '@auth/constants';
import { getServerSideKeyService } from '@auth/serverKeys';
import { apiKeyCommands } from '@commands/api/apiKeyCommands';
import { toErrorMessage } from '@common/errors';
import { GlobalStateKey, globalSM } from '@common/state';
import { SecretManager } from '@frontend/secretManager';
import * as logger from '@logger/logUtils';
import { generateExecutionId } from '@utils/core/executionId';

const CHANNEL = 'SetupAssistant';
logger.initialize(CHANNEL);

export const setupAssistantCommands = {
  runSetupAssistant: 'texra.runSetupAssistant',
};

/**
 * Model to launch with when the user is signed in to Researcher Access
 * (server-side keys cover Gemini).
 */
const SIGNED_IN_SETUP_MODEL = 'gemini31p';

/**
 * Provider → model mapping used when the user only has a direct API key.
 * Each mapping points at a model routed through that same provider, so the
 * agent can actually authenticate with the key it's been given.
 */
const API_KEY_MODEL_BY_PROVIDER: Readonly<Record<string, string>> = {
  anthropic: 'opus47T',
  openai: 'gpt54',
  google: 'gemini31p',
  deepseek: 'deepseekT',
  openRouter: 'sonnet46T',
  xai: 'grok4',
  moonshot: 'kimi25T',
  dashscope: 'qwen3max',
  minimax: 'minimax01',
  glm: 'glm5',
};

const SETUP_INSTRUCTION =
  'Please help me finish installing TeXRA. Probe my environment, install anything missing, and get me a working credential.';

/**
 * Result of launch-model resolution. `restoreOpenRouter` is populated when
 * we temporarily flipped the global `useOpenRouter` flag so that the
 * caller can restore the prior value once the setup agent finishes.
 */
interface LaunchModelResolution {
  model: string;
  /** Prior value of the `useOpenRouter` flag if we flipped it, else undefined. */
  restoreOpenRouter?: boolean;
}

/**
 * Pick a model the setup agent can actually call, given the credentials
 * the user currently has. Order:
 *   1. Researcher Access — only when the user's "Use Included Access"
 *      mode is actually on (auth.authenticated alone is insufficient:
 *      a signed-in user who flipped Included Access off will not get
 *      server-side keys routed through their calls).
 *   2. Any direct API key for a provider whose default model routes
 *      through that same provider directly (deterministic by
 *      `SecretManager.API_PROVIDERS` order). Preferred over OpenRouter
 *      so we don't have to flip the global `useOpenRouter` flag.
 *   3. Only then, if `openRouter` is the sole provider with a key, do we
 *      temporarily enable `useOpenRouter` and pick the OpenRouter-backed
 *      default. The prior value is captured in `restoreOpenRouter` so
 *      the caller can reset the flag after the setup agent completes —
 *      otherwise running setup once would permanently reroute the user's
 *      other agent runs through OpenRouter.
 */
async function resolveLaunchModel(): Promise<LaunchModelResolution> {
  if (await getServerSideKeyService().canUseServerSideKeys()) {
    return { model: SIGNED_IN_SETUP_MODEL };
  }

  for (const provider of SecretManager.API_PROVIDERS) {
    if (provider === 'openRouter') continue;
    if (await SecretManager.apiKeyExists(provider)) {
      return {
        model: API_KEY_MODEL_BY_PROVIDER[provider] ?? SIGNED_IN_SETUP_MODEL,
      };
    }
  }

  if (await SecretManager.apiKeyExists('openRouter')) {
    const prior = globalSM.get<boolean>(GlobalStateKey.USE_OPENROUTER) === true;
    if (!prior) {
      await globalSM.update(GlobalStateKey.USE_OPENROUTER, true);
    }
    return {
      model: API_KEY_MODEL_BY_PROVIDER.openRouter ?? SIGNED_IN_SETUP_MODEL,
      restoreOpenRouter: prior,
    };
  }

  return { model: SIGNED_IN_SETUP_MODEL };
}

/**
 * Pre-flight: ensure the user has a *usable* credential before we launch
 * the setup agent. `SecretManager.anyApiKeyExists` already encodes both
 * paths (direct provider key OR Researcher Access sign-in with Included
 * Access enabled), so a signed-in user who has turned Included Access
 * off is correctly treated as having no credential.
 */
async function ensureCredentialOrPrompt(): Promise<boolean> {
  if (await SecretManager.anyApiKeyExists()) return true;

  const picks = [
    {
      label: '$(sign-in) Sign in for free (recommended)',
      description: 'Researcher Access Program — no API key needed',
      id: 'signIn' as const,
    },
    {
      label: '$(key) I have an API key',
      description: 'Paste a provider API key (OpenAI, Anthropic, etc.)',
      id: 'apiKey' as const,
    },
    {
      label: '$(book) Open the manual walkthrough instead',
      description: 'Step through the Getting Started guide yourself',
      id: 'walkthrough' as const,
    },
  ];

  const picked = await vscode.window.showQuickPick(picks, {
    placeHolder:
      'TeXRA needs a credential before the setup assistant can run models.',
    title: 'TeXRA Setup',
  });

  if (!picked) return false;

  if (picked.id === 'signIn') {
    await vscode.commands.executeCommand(AUTH_COMMANDS.SIGN_IN);
    return SecretManager.anyApiKeyExists();
  }

  if (picked.id === 'apiKey') {
    await vscode.commands.executeCommand(apiKeyCommands.setApiKey);
    return SecretManager.anyApiKeyExists();
  }

  // walkthrough
  await vscode.commands.executeCommand('texra.openGettingStarted');
  return false;
}

async function runSetupAssistant(): Promise<void> {
  try {
    const proceed = await ensureCredentialOrPrompt();
    if (!proceed) {
      void vscode.window.showInformationMessage(
        'Setup assistant cancelled. Run `TeXRA: Run Setup Assistant` again once you have signed in or set an API key.',
      );
      return;
    }

    const resolution = await resolveLaunchModel();
    const config = AgentConfigSchema.parse({
      agent: 'setup',
      agentCategory: 'toolUse',
      model: resolution.model,
      instruction: SETUP_INSTRUCTION,
    });

    const executionId = generateExecutionId();
    await registerExecution(executionId, config, config.agent);
    try {
      await executeAgent(config, executionId);
    } finally {
      // If we flipped the global OpenRouter routing flag to launch a
      // router-backed setup model, restore the prior value now that the
      // setup run has finished. Leaving it sticky would silently reroute
      // the user's other agents through OpenRouter on subsequent runs.
      if (resolution.restoreOpenRouter !== undefined) {
        await globalSM
          .update(GlobalStateKey.USE_OPENROUTER, resolution.restoreOpenRouter)
          .then(undefined, (err) => {
            logger.error(
              CHANNEL,
              'Failed to restore useOpenRouter flag after setup.',
              { data: err },
            );
          });
      }
    }
  } catch (error) {
    logger.error(CHANNEL, 'Setup assistant failed to launch.', { data: error });
    void vscode.window.showErrorMessage(
      `Failed to launch setup assistant: ${toErrorMessage(error)}`,
    );
  }
}

export function registerSetupAssistantCommand(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      setupAssistantCommands.runSetupAssistant,
      runSetupAssistant,
    ),
  );
}
