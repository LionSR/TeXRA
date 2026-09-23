import { Effect } from 'effect';

import {
  validateRunRequest,
  type ValidatedRunRequest,
} from '@agent/core/state/runRequests';
import { withLogChannel } from '@logger/effectLog';
import { hasUsableApiKey, API_PROVIDERS } from '@model/apiProviders';
import { SETUP_MODEL_BY_PROVIDER } from '@model/setupModelDefaults';
import {
  decideRunModel,
  type RunModelCandidate,
  type RunModelDecisionReason,
} from '@model/runModelDecision';
import { shouldRouteModelThroughOpenRouter } from '@model/openRouterRouting';
import { getRuntimeModelConfig } from '@model/runtimeModelRegistry';
import {
  probeSetupCredential,
  setupCredentialProbeFailed,
  setupSubscriptionModel,
} from '@model/setupCredentialAccess';
import type { StateReadFailed } from '@platform/interfaces';
import type { LanguageModel } from '@platform/languageModel';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { AgentCategory } from '@shared/schemas';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { getUseOpenRouter } from '@utils/config/providerConfig';

/** Instruction handed to the setup agent when launched. Shared by every host. */
export const SETUP_INSTRUCTION =
  'Finish installing TeXRA. Probe my environment, install anything missing, and configure a working credential.';

/**
 * Scan non-OpenRouter setup credentials in host-shared priority order:
 * ChatGPT/Codex subscription, Grok subscription, then direct provider key.
 */
export function selectSetupCredentialModelExcludingOpenRouter(
  stores: SettingsStores,
  secrets: PlatformSecrets,
  useOpenRouter = false,
): Effect.Effect<string | null, never, LanguageModel> {
  return Effect.gen(function* () {
    // Subscription routes follow the global OpenRouter selection.
    // When it is enabled, only managed direct credentials can bypass it.
    if (!useOpenRouter) {
      const subscriptionModel = yield* setupSubscriptionModel(stores).pipe(
        withLogChannel('Setup Credentials'),
      );
      if (subscriptionModel !== null) return subscriptionModel;
    }

    for (const provider of API_PROVIDERS) {
      if (provider === 'openRouter') continue;
      const model = SETUP_MODEL_BY_PROVIDER[provider];
      if (!model) continue;
      const config = getRuntimeModelConfig(model);
      if (!config || shouldRouteModelThroughOpenRouter(config, useOpenRouter)) {
        continue;
      }
      const hasApiKey = yield* probeSetupCredential(
        hasUsableApiKey(secrets, provider).pipe(
          Effect.mapError(setupCredentialProbeFailed(`${provider} API key`)),
        ),
      ).pipe(withLogChannel('Setup Credentials'));
      if (hasApiKey) return model;
    }

    return null;
  });
}

interface SetupModelResolution {
  model: string;
  reason: RunModelDecisionReason;
}

/**
 * Resolve a launch model for the setup agent from router config, direct
 * credential, and (only when a host asks for it) an OpenRouter access-list
 * fallback used as a last resort when routing is off. Desktop has no prompt
 * to explain the resulting flag flip, so it opts out of the fallback; the
 * extension prompts the user first (`ensureRoutingConfigured`) and can offer
 * it.
 */
export function resolveSetupLaunchModel(
  stores: SettingsStores,
  secrets: PlatformSecrets,
  includeAccessListFallback: boolean,
): Effect.Effect<SetupModelResolution | null, StateReadFailed, LanguageModel> {
  return Effect.gen(function* () {
    const useOpenRouter = yield* getUseOpenRouter(stores);
    const hasOpenRouterKey = yield* probeSetupCredential(
      hasUsableApiKey(secrets, 'openRouter').pipe(
        Effect.mapError(setupCredentialProbeFailed('OpenRouter API key')),
      ),
    ).pipe(withLogChannel('Setup Credentials'));
    const openRouterModel = hasOpenRouterKey
      ? SETUP_MODEL_BY_PROVIDER.openRouter
      : null;
    const credentialModel =
      useOpenRouter && openRouterModel
        ? null
        : yield* selectSetupCredentialModelExcludingOpenRouter(
            stores,
            secrets,
            useOpenRouter,
          );

    const candidates: RunModelCandidate[] = [
      {
        model: useOpenRouter ? openRouterModel : null,
        reason: 'router-config',
      },
      {
        model: credentialModel,
        reason: 'credential',
      },
    ];
    if (includeAccessListFallback) {
      candidates.push({
        model: useOpenRouter ? null : openRouterModel,
        reason: 'access-list-default',
      });
    }

    const decision = decideRunModel(candidates);
    return decision ? { model: decision.model, reason: decision.reason } : null;
  });
}

/**
 * Build the validated run request that launches the setup conversation, or
 * `null` when no credential resolves to a runnable model.
 *
 * Desktop has no routing prompt, so OpenRouter is chosen only when the flag is
 * already on and an OpenRouter key exists: the access-list fallback is opted
 * out and the resolution is projected to its model.
 */
export function buildDesktopSetupRunRequest(
  stores: SettingsStores,
  secrets: PlatformSecrets,
): Effect.Effect<ValidatedRunRequest | null, Error, LanguageModel> {
  return Effect.gen(function* () {
    const model =
      (yield* resolveSetupLaunchModel(stores, secrets, false))?.model ?? null;
    if (!model) return null;
    const validation = validateRunRequest({
      config: {
        agent: SETUP_AGENT_NAME,
        agentCategory: AgentCategory.ToolUse,
        model,
        instruction: SETUP_INSTRUCTION,
      },
    });
    if (!validation.valid) {
      return yield* Effect.fail(new Error(validation.message));
    }
    return validation.request;
  });
}
