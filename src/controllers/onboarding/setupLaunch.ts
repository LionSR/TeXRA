import { getServerSideKeyService } from '@auth/serverKeys';
import { lookupApiKey, API_PROVIDERS } from '@model/apiProviders';
import { isCodexSubscriptionActive } from '@model/providerCapabilities';
import {
  decideRunModel,
  type RunModelCandidate,
  type RunModelDecisionReason,
} from '@model/runModelDecision';
import {
  CHATGPT_SETUP_MODEL,
  SETUP_MODEL_BY_PROVIDER,
} from '@model/setupModelDefaults';
import { shouldRouteModelThroughOpenRouter } from '@model/openRouterRouting';
import { getRuntimeModelConfig } from '@model/runtimeModelRegistry';
import { platform } from '@platform/platform';
import type { PlatformSecrets } from '@platform/secrets';
import { AgentCategory, type MainViewExecuteMessage } from '@shared/schemas';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { DEFAULT_AGENT_MODEL } from '@shared/constants/providers';
import { isNonEmptyString } from '@utils/core';
import { getUseOpenRouter } from '@utils/config/providerConfig';

/** Instruction handed to the setup agent when launched. Shared by every host. */
export const SETUP_INSTRUCTION =
  'Finish installing TeXRA. Probe my environment, install anything missing, and configure a working credential.';

/**
 * Scan non-OpenRouter setup credentials in host-shared priority order:
 * ChatGPT/Codex subscription, server-side default, server-side provider setup
 * model, then direct provider key.
 */
export async function selectSetupCredentialModelExcludingOpenRouter(
  secrets: PlatformSecrets,
  useOpenRouter = false,
): Promise<string | null> {
  // Subscription and relay routes follow the global OpenRouter selection.
  // When it is enabled, only managed direct credentials can bypass it.
  if (!useOpenRouter) {
    if (await isCodexSubscriptionActive(CHATGPT_SETUP_MODEL)) {
      return CHATGPT_SETUP_MODEL;
    }

    const serverKeys = getServerSideKeyService();
    if (await serverKeys.canUseServerSideKeysForModel(DEFAULT_AGENT_MODEL)) {
      return DEFAULT_AGENT_MODEL;
    }
    if (await serverKeys.canUseServerSideKeys()) {
      for (const [provider, model] of Object.entries(SETUP_MODEL_BY_PROVIDER)) {
        if (provider === 'openRouter') continue;
        if (serverKeys.canUseModelSync(model)) return model;
      }
    }
  }

  for (const provider of API_PROVIDERS) {
    if (provider === 'openRouter') continue;
    const model = SETUP_MODEL_BY_PROVIDER[provider];
    if (!model) continue;
    const config = getRuntimeModelConfig(model);
    if (!config || shouldRouteModelThroughOpenRouter(config, useOpenRouter)) {
      continue;
    }
    if (isNonEmptyString(await lookupApiKey(secrets, provider))) {
      return model;
    }
  }

  return null;
}

export interface SetupModelResolution {
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
export async function resolveSetupLaunchModel(
  secrets: PlatformSecrets,
  includeAccessListFallback: boolean,
): Promise<SetupModelResolution | null> {
  const useOpenRouter = getUseOpenRouter();
  const openRouterModel = isNonEmptyString(
    await lookupApiKey(secrets, 'openRouter'),
  )
    ? SETUP_MODEL_BY_PROVIDER.openRouter
    : null;
  const credentialModel =
    useOpenRouter && openRouterModel
      ? null
      : await selectSetupCredentialModelExcludingOpenRouter(
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
}

/**
 * Desktop has no routing prompt, so OpenRouter is chosen only when the flag is
 * already on and an OpenRouter key exists.
 */
export async function selectDesktopSetupModel(): Promise<string | null> {
  const resolution = await resolveSetupLaunchModel(platform().secrets, false);
  return resolution?.model ?? null;
}

/**
 * Build the execute message that launches the setup conversation, or `null`
 * when no credential resolves to a runnable model. The message rides the same
 * `handleExecute` path the renderer's execute button uses.
 */
export async function buildDesktopSetupExecuteMessage(): Promise<MainViewExecuteMessage | null> {
  const model = await selectDesktopSetupModel();
  if (!model) return null;
  return {
    agent: SETUP_AGENT_NAME,
    model,
    instruction: SETUP_INSTRUCTION,
    agentCategory: AgentCategory.ToolUse,
  };
}
