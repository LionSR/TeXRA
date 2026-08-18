import { ModelProvider, type ModelConfig } from 'llm-zoo';

import { zeroCostAccessOverrides } from '@model/subscriptionAccessOverrides';
import { isCodexSignedIn } from '@model/codex/codexSignedIn';
import { isPreferCodexSubscription } from '@model/codex/codexPreference';
import { isPreferXaiSubscription } from '@model/xai/xaiPreference';
import { isXaiSignedIn } from '@model/xai/xaiSignedIn';
import type { UsageRoute } from '@shared/schemas';
import { isKimiSubscriptionEligible } from '@shared/model/kimiCodeRetryGate';
import { getUseOpenRouter } from '@utils/config/providerConfig';

import {
  isKimiCodeRoute,
  resolveKimiCodeRoutingFacts,
} from './kimiCodeSubscriptionRouting';
import { resolveRuntimeModelConfig } from './runtimeModelRegistry';

type ProviderAuthMode = 'chatgpt-subscription' | 'xai-subscription';

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

/**
 * ChatGPT-subscription Codex input budget. Matches Codex CLI 0.145.0's
 * `context_window` / `max_context_window` for GPT-5.5 and GPT-5.6 Sol /
 * Terra / Luna. Displayed context is this plus the registry `maxOutputTokens`
 * (128k → 400k), same split OpenCode uses.
 */
export const CODEX_DEFAULT_SUBSCRIPTION_INPUT_LIMIT = 272_000;

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

/** Resolve the active ChatGPT-subscription (Codex) provider profile. */
export function resolveCodexSubscriptionProfile({
  model,
  useOpenRouter,
}: ProviderCapabilityKey): ProviderCapabilityProfile | null {
  if (useOpenRouter) return null;
  if (model.provider !== ModelProvider.OPENAI) return null;
  if (model.openRouterOnly) return null;
  if (!isCodexSubscriptionEligible(model)) return null;
  const inputTokenLimit = Math.min(
    CODEX_DEFAULT_SUBSCRIPTION_INPUT_LIMIT,
    model.contextWindow,
  );
  const contextWindow = Math.min(
    inputTokenLimit + model.maxOutputTokens,
    model.contextWindow,
  );

  return {
    authMode: 'chatgpt-subscription',
    ...zeroCostAccessOverrides(contextWindow),
    inputTokenLimit,
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

/**
 * Resolve ChatGPT-subscription capabilities for a model, or null when the
 * subscription preference is off or the model is not Codex-eligible.
 */
export function resolveCodexSubscriptionCapabilities(
  config: ModelConfig,
  useOpenRouter: boolean,
): ProviderCapabilityProfile | null {
  if (!isPreferCodexSubscription()) return null;
  return resolveCodexSubscriptionProfile({ model: config, useOpenRouter });
}

/**
 * Shared signed-in-subscription probe: resolve the model config, ask the
 * per-provider capability resolver whether the subscription route is active
 * under the live OpenRouter toggle, and confirm the provider is signed in.
 * The Kimi probe cannot share this (it has no sign-in probe and adds the
 * key-set + included-access facts), so it stays standalone.
 */
async function isSignedInSubscriptionActive(
  modelId: string,
  resolveCapabilities: (
    config: ModelConfig,
    useOpenRouter: boolean,
  ) => ProviderCapabilityProfile | null,
  isSignedIn: () => boolean | Promise<boolean>,
): Promise<boolean> {
  const config = await resolveRuntimeModelConfig(modelId);
  if (!config) return false;
  const capabilities = resolveCapabilities(config, getUseOpenRouter());
  if (!capabilities) return false;
  return isSignedIn();
}

/** Whether the model currently routes through a signed-in ChatGPT subscription. */
export async function isCodexSubscriptionActive(
  modelId: string,
): Promise<boolean> {
  return isSignedInSubscriptionActive(
    modelId,
    resolveCodexSubscriptionCapabilities,
    isCodexSignedIn,
  );
}

/**
 * Resolve the active Grok-subscription provider profile, or null when the
 * subscription preference is off, OpenRouter is selected, or the model is not
 * xAI-eligible. All non-OpenRouter-only xAI registry models qualify; the OAuth
 * token hits the same `api.x.ai` surface as an API key.
 */
export function resolveXaiSubscriptionCapabilities(
  config: ModelConfig,
  useOpenRouter: boolean,
): ProviderCapabilityProfile | null {
  if (!isPreferXaiSubscription()) return null;
  if (useOpenRouter) return null;
  if (config.provider !== ModelProvider.XAI) return null;
  if (config.openRouterOnly) return null;
  return {
    authMode: 'xai-subscription',
    ...zeroCostAccessOverrides(config.contextWindow),
    usageRoute: 'xai-subscription',
  };
}

/** Whether the model currently routes through a signed-in Grok subscription. */
export async function isXaiSubscriptionActive(
  modelId: string,
): Promise<boolean> {
  return isSignedInSubscriptionActive(
    modelId,
    resolveXaiSubscriptionCapabilities,
    isXaiSignedIn,
  );
}

/**
 * Whether the model currently routes through the Kimi Code coding endpoint
 * (Moonshot coding subscription, authenticated by the Kimi Code API key).
 * Mirrors ModelFactory's dispatch facts: registry eligibility, the OpenRouter
 * toggle, included (relay) access, a stored key, and the "Prefer Kimi Code"
 * switch.
 */
export async function isKimiCodeSubscriptionActive(
  modelId: string,
): Promise<boolean> {
  const config = await resolveRuntimeModelConfig(modelId);
  if (!config || !isKimiSubscriptionEligible(config)) return false;
  return isKimiCodeRoute(
    config,
    await resolveKimiCodeRoutingFacts(getUseOpenRouter()),
  );
}
