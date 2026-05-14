// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { AgentConfigSchema } from '@agent/core';
import { loadAgents } from '@agent/index';
import { registerExecution } from '@agent/storage';
import { executeAgent } from '@agent/runtime/executeAgent';
import { AUTH_COMMANDS } from '@auth/constants';
import { getServerSideKeyService } from '@auth/serverKeys';
import { apiKeyCommands } from '@commands/api/apiKeyCommands';
import { toErrorMessage } from '@common/errors';
import { GlobalStateKey, globalSM } from '@common/state';
import { SecretManager } from '@frontend/secretManager';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import * as logger from '@logger/logUtils';
import { generateExecutionId } from '@utils/core/executionId';
import { getUseOpenRouter } from '@utils/config/providerConfig';

const CHANNEL = 'SetupAssistant';
logger.initialize(CHANNEL);

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
  openai: 'gpt55',
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
 * the user currently has AND the global `useOpenRouter` routing flag
 * (already validated by the caller). Pure: never mutates state.
 *
 * Returns `null` when every resolution path fails — e.g. the user is
 * signed in with Included Access but their tier excludes every model we
 * know how to route, and they've added no direct or OpenRouter key.
 * The caller surfaces that as a clear preflight error rather than
 * launching with a model that will crash on tier enforcement.
 *
 * Order:
 *   1. Researcher Access — only when "Use Included Access" is actually
 *      on AND the signed-in setup model is in the user's tier. A plain
 *      `canUseServerSideKeys()` pass is insufficient because a lower-tier
 *      user may have server-side access to *some* models but not
 *      `SIGNED_IN_SETUP_MODEL`; we'd otherwise fall through preflight
 *      and fail at runtime when tier enforcement kicks in.
 *   2. If the user is signed in but `SIGNED_IN_SETUP_MODEL` is not in
 *      tier, scan `API_KEY_MODEL_BY_PROVIDER` for any model that IS in
 *      tier so a lower-tier signed-in user still gets a working launch.
 *   3. Any direct API key for a provider whose default model routes
 *      through that same provider directly (iterating
 *      `SecretManager.API_PROVIDERS` for deterministic ordering). Preferred
 *      over OpenRouter so we don't need to touch the routing flag at all.
 *   4. Only if `openRouter` is the sole provider with a key, report a
 *      router-backed default and let the caller temporarily flip the flag.
 */
async function resolveLaunchModel(): Promise<LaunchModelResolution | null> {
  const serverKeys = getServerSideKeyService();

  // When global OR routing is on, every model call is re-routed through
  // OpenRouter at the ModelFactory level regardless of what we pick for
  // "direct" here — so a server-side or direct-provider pick would be
  // silently misrouted (and possibly land on a model OR doesn't carry).
  // `ensureRoutingConfigured` has already validated an OR key is
  // present, so we can short-circuit to the OR-routed default. Returning
  // `requiresOpenRouter: true` is a no-op in the flip helper when the
  // global flag is already on, so this doesn't mutate anything.
  if (getUseOpenRouter()) {
    return {
      model: API_KEY_MODEL_BY_PROVIDER.openRouter,
      requiresOpenRouter: true,
    };
  }

  if (await serverKeys.canUseServerSideKeysForModel(SIGNED_IN_SETUP_MODEL)) {
    return { model: SIGNED_IN_SETUP_MODEL, requiresOpenRouter: false };
  }

  // Step 2: signed-in user whose tier excludes the default signed-in
  // model. Look for any tier-available *directly-routed* model among the
  // per-provider defaults. Skip the `openRouter` entry because that
  // model (e.g. `sonnet46T`) is specifically for OR-routed calls and
  // routing it direct via server-side keys would pick the wrong backend.
  if (await serverKeys.canUseServerSideKeys()) {
    for (const [provider, model] of Object.entries(API_KEY_MODEL_BY_PROVIDER)) {
      if (provider === 'openRouter') continue;
      if (serverKeys.canUseModelSync(model)) {
        return { model, requiresOpenRouter: false };
      }
    }
  }

  // Step 3: direct provider key. Only consider providers we know how to
  // map to a default model — silently falling back to `SIGNED_IN_SETUP_MODEL`
  // (a Google model) for an unmapped provider would produce a runtime
  // auth failure with a credential that can't reach Google.
  for (const provider of SecretManager.API_PROVIDERS) {
    if (provider === 'openRouter') continue;
    const model = API_KEY_MODEL_BY_PROVIDER[provider];
    if (!model) continue;
    if (await SecretManager.hasUsableApiKey(provider)) {
      return { model, requiresOpenRouter: false };
    }
  }

  // Step 4: only OpenRouter key present. The `openRouter` entry is
  // statically declared in `API_KEY_MODEL_BY_PROVIDER`, so no fallback
  // is needed.
  if (await SecretManager.hasUsableApiKey('openRouter')) {
    return {
      model: API_KEY_MODEL_BY_PROVIDER.openRouter,
      requiresOpenRouter: true,
    };
  }

  return null;
}

/**
 * Temporarily flip the `useOpenRouter` flag *on* for the scoped callback
 * and always restore in a `finally`. Only used in the narrow OR-only
 * case — i.e. the user has no server-side access and no direct provider
 * key, only an OpenRouter key. In that state, any other agent they could
 * launch concurrently would also need OpenRouter routing (they have no
 * other credential), so the global flip matches what the user wants
 * anyway and can't break a concurrent non-OR agent.
 *
 * The reverse direction (flag on, direct provider picked) is *not*
 * handled here — it's caught at preflight and surfaced as a settings
 * misconfiguration the user must resolve, so we never mutate shared
 * routing state against a user who deliberately enabled OpenRouter.
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
 * Pre-flight: ensure the user has a *usable* credential before we launch
 * the setup agent. Direct uses of `SecretManager.anyApiKeyExists` would
 * report a blank `PROVIDER_API_KEY=""` env var as present, which then
 * fails in `resolveLaunchModel` with a confusing "No model is available"
 * modal. `hasAnyUsableCredential()` mirrors the adapter-level check:
 * at least one provider with a non-blank key, or valid server-side
 * access. Keeps preflight and launch agreed on what "has a credential"
 * means.
 */
async function hasAnyUsableCredential(): Promise<boolean> {
  for (const provider of SecretManager.API_PROVIDERS) {
    if (await SecretManager.hasUsableApiKey(provider)) return true;
  }
  return getServerSideKeyService().canUseServerSideKeys();
}

async function ensureCredentialOrPrompt(): Promise<boolean> {
  if (await hasAnyUsableCredential()) return true;

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
    return hasAnyUsableCredential();
  }

  if (picked.id === 'apiKey') {
    await vscode.commands.executeCommand(apiKeyCommands.setApiKey);
    return hasAnyUsableCredential();
  }

  // walkthrough
  await vscode.commands.executeCommand('texra.openGettingStarted');
  return false;
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
  if (!getUseOpenRouter()) return true;
  if (await SecretManager.hasUsableApiKey('openRouter')) return true;

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
  if (!getUseOpenRouter()) return true;
  if (await SecretManager.hasUsableApiKey('openRouter')) return true;
  return false;
}

export async function runSetupAssistant(): Promise<void> {
  try {
    const proceed = await ensureCredentialOrPrompt();
    if (!proceed) {
      void vscode.window.showInformationMessage(
        'Setup assistant cancelled. Run `TeXRA: Run Setup Assistant` again once you have signed in or set an API key.',
      );
      return;
    }

    if (!(await ensureRoutingConfigured())) {
      void vscode.window.showInformationMessage(
        'Setup assistant cancelled. Resolve the "Use OpenRouter" configuration (add an OpenRouter key or disable the setting in Dashboard → Models), then run `TeXRA: Run Setup Assistant` again.',
      );
      return;
    }

    const resolution = await resolveLaunchModel();
    if (!resolution) {
      // Edge case: signed in with Included Access but tier excludes every
      // setup-model candidate, and no direct/OR keys to fall back on.
      // Refuse launch rather than pick a model that crashes at runtime.
      const choice = await vscode.window.showWarningMessage(
        'No model is available for your current credentials and tier. Add a provider API key or upgrade your Researcher Access tier, then retry.',
        { modal: true },
        'Set API key',
        'Open Models tab',
      );
      if (choice === 'Set API key') {
        await vscode.commands.executeCommand(apiKeyCommands.setApiKey);
      } else if (choice === 'Open Models tab') {
        await vscode.commands.executeCommand('texra.showModels');
      }
      return;
    }

    const config = AgentConfigSchema.parse({
      agent: 'setup',
      agentCategory: 'toolUse',
      model: resolution.model,
      instruction: SETUP_INSTRUCTION,
    });

    // Activation fires `loadAgents()` fire-and-forget, so a user
    // invoking the setup assistant from the first walkthrough step (or
    // immediately after install, especially with remote-agent fetches
    // in flight) can race the agent registry and hit "Could not find
    // agent: setup". `loadAgents()` is idempotent: it returns the
    // in-flight promise if loading is still running, or resolves
    // immediately if already initialized, or kicks off a fresh load.
    await loadAgents();

    const launch = async () => {
      const executionId = generateExecutionId();
      await registerExecution(executionId, config, config.agent);
      await executeAgent(config, executionId, {
        runtimeHost: extensionAgentRuntimeHost,
      });
    };

    if (resolution.requiresOpenRouter) {
      await withOpenRouterFlagOn(launch);
    } else {
      await launch();
    }
  } catch (error) {
    logger.error(CHANNEL, 'Setup assistant failed to launch.', { data: error });
    void vscode.window.showErrorMessage(
      `Failed to launch setup assistant: ${toErrorMessage(error)}`,
    );
  }
}
