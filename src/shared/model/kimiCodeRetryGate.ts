/**
 * Browser-safe Kimi Code exclusivity gate for retry switches.
 *
 * The host-side route resolver (`@model/kimiCodeSubscriptionRouting`) owns the
 * equivalent predicate for routing decisions; this module is deliberately free
 * of platform/secret-store imports so webview panels can read the same static
 * llm-zoo registry facts when deciding whether to offer an API-key switch.
 */
import { MODEL_CONFIGS, ModelProvider } from 'llm-zoo';

import { KIMI_CODE_BASE_URL } from '@shared/constants/providers';

/**
 * Whether the retrying model is served ONLY by the Kimi Code coding endpoint
 * (`kimi-for-coding` aliases pin their `baseUrl` in the registry). Unknown or
 * non-Kimi models are not exclusive, so a missing `model` never blocks the
 * GLM/Kimi dual-backend switch.
 */
export function isKimiCodeExclusiveRetryModel(
  model: string | undefined,
): boolean {
  if (model === undefined) return false;
  const config = MODEL_CONFIGS[model];
  return (
    config !== undefined &&
    config.provider === ModelProvider.MOONSHOT &&
    config.kimiSubscription === true &&
    config.baseUrl === KIMI_CODE_BASE_URL
  );
}
