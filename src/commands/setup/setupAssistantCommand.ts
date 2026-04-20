// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { AgentConfigSchema } from '@agent/core';
import { registerExecution } from '@agent/storage';
import { executeAgent } from '@agent/runtime/executeAgent';
import { AUTH_COMMANDS } from '@auth/constants';
import { getAuthStatus } from '@auth/authCommands';
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
 * Pick a model the setup agent can actually call, given the credentials
 * the user currently has. Order:
 *   1. Researcher Access sign-in → SIGNED_IN_SETUP_MODEL.
 *   2. Any direct API key for a provider whose default model routes
 *      through that same provider directly (deterministic by
 *      `SecretManager.API_PROVIDERS` order). Preferred over OpenRouter
 *      so we don't have to flip the global `useOpenRouter` flag.
 *   3. Only then, if `openRouter` is the sole provider with a key, do we
 *      enable `useOpenRouter` (a sticky global setting) and pick the
 *      OpenRouter-backed default. Doing this only as a last resort means
 *      a user with `openRouter + anthropic` doesn't have their other
 *      agents silently rerouted through OpenRouter the next time.
 */
async function resolveLaunchModel(): Promise<string> {
  const auth = await getAuthStatus().catch(() => ({ authenticated: false }));
  if (auth.authenticated) return SIGNED_IN_SETUP_MODEL;

  for (const provider of SecretManager.API_PROVIDERS) {
    if (provider === 'openRouter') continue;
    if (await SecretManager.apiKeyExists(provider)) {
      return API_KEY_MODEL_BY_PROVIDER[provider] ?? SIGNED_IN_SETUP_MODEL;
    }
  }

  if (await SecretManager.apiKeyExists('openRouter')) {
    await globalSM.update(GlobalStateKey.USE_OPENROUTER, true);
    return API_KEY_MODEL_BY_PROVIDER.openRouter ?? SIGNED_IN_SETUP_MODEL;
  }

  return SIGNED_IN_SETUP_MODEL;
}

/**
 * Pre-flight: ensure the user has *some* credential before we launch the
 * setup agent (otherwise the first probe will report "no credential" and
 * the agent itself cannot call a model). Returns true if we should proceed.
 */
async function ensureCredentialOrPrompt(): Promise<boolean> {
  const anyKey = await SecretManager.anyApiKeyExists();
  if (anyKey) return true;

  const auth = await getAuthStatus().catch(() => ({
    authenticated: false,
  }));
  if (auth.authenticated) return true;

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
    const postAuth = await getAuthStatus().catch(() => ({
      authenticated: false,
    }));
    return postAuth.authenticated;
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

    const model = await resolveLaunchModel();
    const config = AgentConfigSchema.parse({
      agent: 'setup',
      agentCategory: 'toolUse',
      model,
      instruction: SETUP_INSTRUCTION,
    });

    const executionId = generateExecutionId();
    await registerExecution(executionId, config, config.agent);
    await executeAgent(config, executionId);
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
