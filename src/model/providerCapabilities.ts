import { ModelProvider, type ModelConfig } from 'llm-zoo';

import {
  isCodexSignedIn,
  isCodexSubscriptionToolUseOnly,
  isPreferCodexSubscription,
} from '@auth/codex';
import { zeroCostAccessOverrides } from '@model/subscriptionAccessOverrides';
import { platform } from '@platform/platform';
import type { UsageRoute } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas/agent';
import {
  getPreferKimiCode,
  getUseOpenRouter,
} from '@utils/config/providerConfig';

import { apiKeyExists } from './apiProviders';
import {
  isKimiSubscriptionEligible,
  resolveKimiCodeRoute,
} from './kimiCodeSubscriptionRouting';
import { resolveRuntimeModelConfig } from './runtimeModelRegistry';

type ProviderAuthMode = 'chatgpt-subscription';

export interface OpenAIResponseProviderCapabilities {
  readonly backgroundMode: 'base' | 'disabled';
  readonly streaming: 'base' | 'forced';
  readonly webSocket: 'base' | 'global-toggle';
  readonly supportsTokenCounting: boolean;
  readonly supportsManualCompaction: boolean;
  readonly supportsResponseChaining: boolean;
  readonly storesResponsesServerSide: boolean;
  readonly supportsInlineInputFileUpload: boolean;
  readonly supportsToolResultFileUpload: boolean;
  readonly failWhenFallbackOutputBudgetIsReduced: boolean;
}

export interface ProviderCapabilityProfile {
  readonly authMode: ProviderAuthMode;
  readonly contextWindow: number;
  readonly inputTokenLimit?: number;
  readonly inputPrice: number;
  readonly outputPrice: number;
  readonly usageRoute?: UsageRoute;
  readonly openAIResponses?: OpenAIResponseProviderCapabilities;
}

export interface ProviderCapabilityKey {
  readonly model: ModelConfig;
  readonly useOpenRouter: boolean;
}

/** Default Codex budget (GPT-5.5 and earlier). */
export const CODEX_DEFAULT_SUBSCRIPTION_CONTEXT_WINDOW = 400_000;
export const CODEX_DEFAULT_SUBSCRIPTION_INPUT_LIMIT = 272_000;

/** GPT-5.6 Codex budget: 372k input plus 128k output. */
export const CODEX_GPT56_SUBSCRIPTION_CONTEXT_WINDOW = 500_000;
export const CODEX_GPT56_SUBSCRIPTION_INPUT_LIMIT = 372_000;

/** Trailing llm-zoo date pin (`-2026-04-23`) on a model `fullName`. */
const CODEX_MODEL_DATE_PIN = /-\d{4}-\d{2}-\d{2}$/;

/**
 * The bare model id the Codex backend keys on: the `shortName` when present,
 * else the `fullName` with its llm-zoo date pin stripped.
 */
export function codexBackendModelId(config: {
  readonly shortName?: string;
  readonly fullName: string;
}): string {
  return config.shortName || config.fullName.replace(CODEX_MODEL_DATE_PIN, '');
}

function codexSubscriptionTokenLimits(model: ModelConfig): {
  contextWindow: number;
  inputTokenLimit: number;
} {
  if (codexBackendModelId(model).startsWith('gpt-5.6')) {
    return {
      contextWindow: CODEX_GPT56_SUBSCRIPTION_CONTEXT_WINDOW,
      inputTokenLimit: CODEX_GPT56_SUBSCRIPTION_INPUT_LIMIT,
    };
  }
  return {
    contextWindow: CODEX_DEFAULT_SUBSCRIPTION_CONTEXT_WINDOW,
    inputTokenLimit: CODEX_DEFAULT_SUBSCRIPTION_INPUT_LIMIT,
  };
}

/**
 * Whether `model` is eligible to route through the ChatGPT-subscription
 * (Codex) backend.
 *
 * Read directly from the llm-zoo `codexSubscription` registry flag (added in
 * llm-zoo 1.15.0), which records whether the Codex backend actually serves
 * the model — sourced from the model manifest embedded in the Codex CLI
 * cross-checked against https://developers.openai.com/codex/models.
 *
 * This replaced a registry-derived heuristic (top reasoning-effort tier,
 * `/codex/i` naming, deprecation status, plus three exception tables) that
 * inferred serving status from proxies and broke whenever they diverged from
 * reality: GPT-5.6 ships with a `medium` default reasoning effort, failed the
 * tier gate, and silently fell back to the user's API key. Serving status is
 * a fact about the Codex backend, not derivable from other model fields — so
 * it lives in the registry data, not in code.
 *
 * Requires `model.provider === ModelProvider.OPENAI` — asserted here (not
 * just by callers) since this function is exported and a non-OpenAI
 * `ModelConfig` must never resolve eligible.
 *
 * Trust boundary: no `retired`/`deprecated` cross-check is layered back on
 * top — the registry owns serving status outright, so an llm-zoo release
 * that retires a model must also flip its `codexSubscription` to false.
 */
export function isCodexSubscriptionEligible(model: ModelConfig): boolean {
  if (model.provider !== ModelProvider.OPENAI) return false;
  return model.codexSubscription === true;
}

/** Resolve the active ChatGPT-subscription provider profile. */
export function resolveProviderCapabilities({
  model,
  useOpenRouter,
}: ProviderCapabilityKey): ProviderCapabilityProfile | null {
  if (useOpenRouter) return null;
  if (model.provider !== ModelProvider.OPENAI) return null;
  if (model.openRouterOnly) return null;
  if (!isCodexSubscriptionEligible(model)) return null;
  const tokenLimits = codexSubscriptionTokenLimits(model);

  return {
    authMode: 'chatgpt-subscription',
    ...zeroCostAccessOverrides(
      Math.min(tokenLimits.contextWindow, model.contextWindow),
    ),
    inputTokenLimit: Math.min(tokenLimits.inputTokenLimit, model.contextWindow),
    usageRoute: 'chatgpt-subscription',
    openAIResponses: {
      backgroundMode: 'disabled',
      streaming: 'forced',
      webSocket: 'global-toggle',
      supportsTokenCounting: false,
      // The backend forces `store: false` (see `storesResponsesServerSide`
      // below), so OpenAI's stateful `/responses/compact` endpoint has
      // nothing to act on. Manual compaction is still supported end-to-end
      // via `ModelHandlerOpenAIResponse`'s client-side summarize-and-resend
      // fallback, which the handler picks automatically whenever
      // `storesResponsesServerSide` is false (#7213).
      supportsManualCompaction: true,
      supportsResponseChaining: false,
      storesResponsesServerSide: false,
      supportsInlineInputFileUpload: false,
      supportsToolResultFileUpload: false,
      failWhenFallbackOutputBudgetIsReduced: true,
    },
  };
}

/** Resolve ChatGPT-subscription capabilities for the requested agent kind. */
export function resolveCodexSubscriptionCapabilitiesForAgentCategory(
  config: ModelConfig,
  useOpenRouter: boolean,
  agentCategory: AgentCategory | undefined,
): ProviderCapabilityProfile | null {
  if (!isPreferCodexSubscription()) return null;
  const capabilities = resolveProviderCapabilities({
    model: config,
    useOpenRouter,
  });
  if (!capabilities) return null;
  if (!isCodexSubscriptionToolUseOnly()) return capabilities;
  return agentCategory === AgentCategory.ToolUse ? capabilities : null;
}

/** Whether the model currently routes through a signed-in ChatGPT subscription. */
export async function isCodexSubscriptionActive(
  modelId: string,
  agentCategory: AgentCategory,
): Promise<boolean> {
  const config = await resolveRuntimeModelConfig(modelId);
  if (!config) return false;
  const capabilities = resolveCodexSubscriptionCapabilitiesForAgentCategory(
    config,
    getUseOpenRouter(),
    agentCategory,
  );
  if (!capabilities) return false;
  return isCodexSignedIn();
}

/**
 * Whether the model currently routes through the Kimi Code coding endpoint
 * (Moonshot coding subscription, authenticated by the Kimi Code API key).
 * Mirrors ModelFactory's dispatch facts: registry eligibility, the OpenRouter
 * toggle, a stored key, and the "Prefer Kimi Code" switch.
 */
export async function isKimiCodeSubscriptionActive(
  modelId: string,
): Promise<boolean> {
  const config = await resolveRuntimeModelConfig(modelId);
  if (!config || !isKimiSubscriptionEligible(config)) return false;
  const keySet = await apiKeyExists(platform().secrets, 'kimiCode');
  return (
    resolveKimiCodeRoute(
      config,
      getUseOpenRouter(),
      keySet,
      getPreferKimiCode(),
    ) === 'kimiCode'
  );
}
