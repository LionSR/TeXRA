import { Effect } from 'effect';
import { ModelProvider, type ModelConfig } from 'llm-zoo';

import { zeroCostAccessOverrides } from '@model/subscriptionAccessOverrides';
import {
  isCodexSignedIn,
  isPreferCodexSubscription,
} from '@model/codex/codexSubscription';
import {
  isPreferXaiSubscription,
  isXaiSignedIn,
} from '@model/xai/xaiSubscription';
import type { LanguageModel } from '@platform/languageModel';
import {
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
  type UsageRoute,
} from '@shared/schemas';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { readSettingFrom } from '@utils/config/platformSettings';
import { getUseOpenRouter } from '@utils/config/providerConfig';

import { resolveRuntimeModelConfig } from './runtimeModelRegistry';

export interface ProviderCapabilityProfile {
  readonly contextWindow: number;
  readonly inputTokenLimit?: number;
  readonly inputPrice: number;
  readonly outputPrice: number;
  readonly usageRoute?: UsageRoute;
}

interface ProviderCapabilityKey {
  readonly stores: SettingsStores;
  readonly model: ModelConfig;
  readonly useOpenRouter: boolean;
}

/** Trailing llm-zoo date pin (`-2026-04-23`) on a model `fullName`. */
const CODEX_MODEL_DATE_PIN = /-\d{4}-\d{2}-\d{2}$/;

/**
 * The model id the Codex backend keys on: the `fullName` with its llm-zoo date
 * pin stripped.
 *
 * Never the `shortName`. That is llm-zoo's display abbreviation, and for every
 * Codex-eligible model but one it happens to equal the backend slug — which is
 * why preferring it went unnoticed. The exception is the GPT-5.6 family, whose
 * members are `gpt-5.6-sol`, `-terra` and `-luna`: there is no bare `gpt-5.6`
 * model anywhere, but that is exactly the `shortName` llm-zoo gives Sol. We
 * sent it and the backend answered
 * `The 'gpt-5.6' model is not supported when using Codex with a ChatGPT
 * account.` — a message that reads as a subscription problem and sends users
 * to check their plan, when the id was simply not a model.
 */
export function codexBackendModelId(config: {
  readonly fullName: string;
}): string {
  return config.fullName.replace(CODEX_MODEL_DATE_PIN, '');
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
 * just by callers) so a non-OpenAI `ModelConfig` never resolves eligible.
 *
 * Trust boundary: no `retired`/`deprecated` cross-check is layered back on
 * top — the registry owns serving status outright, so an llm-zoo release
 * that retires a model must also flip its `codexSubscription` to false.
 */
function isCodexSubscriptionEligible(model: ModelConfig): boolean {
  if (model.provider !== ModelProvider.OPENAI) return false;
  return model.codexSubscription === true;
}

/** Resolve the active ChatGPT-subscription (Codex) provider profile. */
function resolveCodexSubscriptionProfile({
  stores,
  model,
  useOpenRouter,
}: ProviderCapabilityKey): ProviderCapabilityProfile | null {
  if (useOpenRouter) return null;
  if (model.provider !== ModelProvider.OPENAI) return null;
  if (model.openRouterOnly) return null;
  if (!isCodexSubscriptionEligible(model)) return null;
  // The setting is stored in thousands of tokens; this is its only reader,
  // so the unit conversion lives here and nowhere else.
  const inputTokenLimit = Math.min(
    readSettingFrom<number>(
      stores,
      CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.configKey,
    ) * CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.tokensPerUnit,
    model.contextWindow,
  );
  const contextWindow = Math.min(
    inputTokenLimit + model.maxOutputTokens,
    model.contextWindow,
  );

  return {
    ...zeroCostAccessOverrides(contextWindow),
    inputTokenLimit,
    usageRoute: 'chatgpt-subscription',
  };
}

/**
 * Resolve ChatGPT-subscription capabilities for a model, or null when the
 * subscription preference is off or the model is not Codex-eligible.
 */
export function resolveCodexSubscriptionCapabilities(
  stores: SettingsStores,
  config: ModelConfig,
  useOpenRouter: boolean,
): ProviderCapabilityProfile | null {
  if (!isPreferCodexSubscription(stores)) return null;
  return resolveCodexSubscriptionProfile({
    stores,
    model: config,
    useOpenRouter,
  });
}

/**
 * Shared signed-in-subscription probe: resolve the model config, ask the
 * per-provider capability resolver whether the subscription route is active
 * under the live OpenRouter toggle, and confirm the provider is signed in.
 * Returns the profile's own `usageRoute` so callers never restate which route
 * a provider serves. The coding plans cannot share this (they have no sign-in
 * probe and add key-set facts), so they answer from their catalog descriptor
 * in `@model/codingPlanSubscriptions`.
 */
const signedInSubscriptionUsageRoute = Effect.fn(
  'providerCapabilities.signedInSubscriptionUsageRoute',
)(function* (
  stores: SettingsStores,
  modelId: string,
  resolveCapabilities: (
    stores: SettingsStores,
    config: ModelConfig,
    useOpenRouter: boolean,
  ) => ProviderCapabilityProfile | null,
  isSignedIn: () => Effect.Effect<boolean>,
): Effect.fn.Return<UsageRoute | undefined, Error, LanguageModel> {
  const config = yield* resolveRuntimeModelConfig(modelId);
  if (!config) return undefined;
  const capabilities = resolveCapabilities(
    stores,
    config,
    getUseOpenRouter(stores),
  );
  if (!capabilities) return undefined;
  const signedIn = yield* isSignedIn();
  return signedIn ? capabilities.usageRoute : undefined;
});

/**
 * The OAuth-subscription route serving this model's next request, if any.
 *
 * Pairing each capability resolver with its own sign-in probe stays inside
 * this module — the one that owns those profiles. `activeSubscriptionUsageRoute`
 * (`@model/codingPlanSubscriptions`) unions this with the API-key coding plans.
 */
export const oauthSubscriptionUsageRoute = Effect.fn(
  'providerCapabilities.oauthSubscriptionUsageRoute',
)(function* (stores: SettingsStores, modelId: string) {
  return (
    (yield* signedInSubscriptionUsageRoute(
      stores,
      modelId,
      resolveCodexSubscriptionCapabilities,
      isCodexSignedIn,
    )) ??
    (yield* signedInSubscriptionUsageRoute(
      stores,
      modelId,
      resolveXaiSubscriptionCapabilities,
      isXaiSignedIn,
    ))
  );
});

/** Whether the model currently routes through a signed-in ChatGPT subscription. */
export const isCodexSubscriptionActive = Effect.fn(
  'providerCapabilities.isCodexSubscriptionActive',
)(function* (stores: SettingsStores, modelId: string) {
  return (
    (yield* signedInSubscriptionUsageRoute(
      stores,
      modelId,
      resolveCodexSubscriptionCapabilities,
      isCodexSignedIn,
    )) !== undefined
  );
});

/**
 * Resolve the active Grok-subscription provider profile, or null when the
 * subscription preference is off, OpenRouter is selected, or the model is not
 * xAI-eligible. All non-OpenRouter-only xAI registry models qualify; the OAuth
 * token hits the same `api.x.ai` surface as an API key.
 */
export function resolveXaiSubscriptionCapabilities(
  stores: SettingsStores,
  config: ModelConfig,
  useOpenRouter: boolean,
): ProviderCapabilityProfile | null {
  if (!isPreferXaiSubscription(stores)) return null;
  if (useOpenRouter) return null;
  if (config.provider !== ModelProvider.XAI) return null;
  if (config.openRouterOnly) return null;
  return {
    ...zeroCostAccessOverrides(config.contextWindow),
    usageRoute: 'xai-subscription',
  };
}

/** Whether the model currently routes through a signed-in Grok subscription. */
export const isXaiSubscriptionActive = Effect.fn(
  'providerCapabilities.isXaiSubscriptionActive',
)(function* (stores: SettingsStores, modelId: string) {
  return (
    (yield* signedInSubscriptionUsageRoute(
      stores,
      modelId,
      resolveXaiSubscriptionCapabilities,
      isXaiSignedIn,
    )) !== undefined
  );
});
