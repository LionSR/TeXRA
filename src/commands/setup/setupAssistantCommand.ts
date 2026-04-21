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
 * Result of launch-model resolution. `requiresOpenRouter` signals that the
 * chosen model needs the global `useOpenRouter` routing flag flipped on;
 * the actual flip/restore is handled by the caller via `withOpenRouterFlag`
 * so that any failure — even in pre-execution setup like `registerExecution`
 * — still restores the prior value.
 */
interface LaunchModelResolution {
  model: string;
  requiresOpenRouter: boolean;
}

/**
 * Pick a model the setup agent can actually call, given the credentials
 * the user currently has. Pure: never mutates global state.
 *
 * Order:
 *   1. Researcher Access — only when "Use Included Access" is actually on
 *      (`auth.authenticated` alone is insufficient: a signed-in user who
 *      turned Included Access off will not get server-side keys routed
 *      through their calls — so `canUseServerSideKeys()` is the real gate).
 *   2. Any direct API key for a provider whose default model routes
 *      through that same provider directly (iterating
 *      `SecretManager.API_PROVIDERS` for deterministic ordering). Preferred
 *      over OpenRouter so we don't need to touch the routing flag at all.
 *   3. Only if `openRouter` is the sole provider with a key, report a
 *      router-backed default and let the caller temporarily flip the flag.
 */
async function resolveLaunchModel(): Promise<LaunchModelResolution> {
  if (await getServerSideKeyService().canUseServerSideKeys()) {
    return { model: SIGNED_IN_SETUP_MODEL, requiresOpenRouter: false };
  }

  for (const provider of SecretManager.API_PROVIDERS) {
    if (provider === 'openRouter') continue;
    if (await SecretManager.apiKeyExists(provider)) {
      return {
        model: API_KEY_MODEL_BY_PROVIDER[provider] ?? SIGNED_IN_SETUP_MODEL,
        requiresOpenRouter: false,
      };
    }
  }

  if (await SecretManager.apiKeyExists('openRouter')) {
    return {
      model: API_KEY_MODEL_BY_PROVIDER.openRouter ?? SIGNED_IN_SETUP_MODEL,
      requiresOpenRouter: true,
    };
  }

  return { model: SIGNED_IN_SETUP_MODEL, requiresOpenRouter: false };
}

/**
 * Single source of truth for the `useOpenRouter` flip/restore dance.
 * When the resolved model requires OpenRouter routing *and* the flag is
 * currently off, flip it on for the scoped callback and always restore in
 * a `finally` — regardless of how the callback exits — so
 * `registerExecution` or `executeAgent` failures can't leave the flag
 * sticky. Otherwise runs the callback with no state mutation at all:
 *   - `requiresOpenRouter === false` → never touches the flag, so a user
 *     who has OpenRouter on (or off) stays wherever they were.
 *   - already enabled → nothing to flip, nothing to restore.
 */
async function withOpenRouterFlag<T>(
  requiresOpenRouter: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  if (!requiresOpenRouter) return fn();
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

    await withOpenRouterFlag(resolution.requiresOpenRouter, async () => {
      const executionId = generateExecutionId();
      await registerExecution(executionId, config, config.agent);
      await executeAgent(config, executionId);
    });
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
