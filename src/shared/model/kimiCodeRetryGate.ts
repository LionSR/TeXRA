/**
 * Browser-safe Kimi Code subscription model facts and retry gate.
 *
 * The pure field-level predicates below are the single source for Kimi Code
 * eligibility/exclusivity. Host-side route resolution
 * (`@model/kimiCodeSubscriptionRouting`) imports them, so routing decisions
 * and webview retry panels can never drift. This module is deliberately free
 * of platform/secret-store imports.
 */
import { MODEL_CONFIGS, ModelProvider } from 'llm-zoo';

import { KIMI_CODE_BASE_URL } from '@shared/constants/providers';

/**
 * The registry facts the eligibility predicates read. Structural (not the full
 * `ModelConfig`) so routing call sites and test fixtures can pass partial
 * configs.
 */
export interface KimiSubscriptionModelFields {
  readonly provider?: string;
  readonly kimiSubscription?: boolean;
  readonly baseUrl?: string;
}

/**
 * Whether `model` is eligible to route through the Kimi Code coding endpoint.
 * Read directly from the llm-zoo `kimiSubscription` registry flag — serving
 * status is a fact about the Kimi Code backend, not derivable from other model
 * fields. Requires `provider === ModelProvider.MOONSHOT`, asserted here since
 * this function is exported and a non-Moonshot config must never resolve
 * eligible.
 */
export function isKimiSubscriptionEligible(
  model: KimiSubscriptionModelFields,
): boolean {
  if (model.provider !== ModelProvider.MOONSHOT) return false;
  return model.kimiSubscription === true;
}

/**
 * Whether `model` is served ONLY by the coding endpoint (no open-platform or
 * OpenRouter route exists). Derived from the registry's pinned `baseUrl` — the
 * pin is what makes the model unreachable anywhere else.
 */
export function isKimiCodeExclusiveModel(
  model: KimiSubscriptionModelFields,
): boolean {
  return (
    isKimiSubscriptionEligible(model) && model.baseUrl === KIMI_CODE_BASE_URL
  );
}

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
  return config !== undefined && isKimiCodeExclusiveModel(config);
}

/**
 * Whether the progress-view retry must not offer the personal API-key switch.
 * Exclusive Kimi Code models have no open-platform fallback when their
 * coding-plan quota is exhausted, so switching to a personal credential cannot
 * reroute them. Both the webview offer gate and the host enforcement gate
 * consume this composed predicate so they cannot desync.
 */
export function isKimiCodeSubscriptionRetryBlocked(
  model: string | undefined,
  exhaustionReason: string | undefined,
): boolean {
  return (
    exhaustionReason === 'kimi-code-subscription' &&
    isKimiCodeExclusiveRetryModel(model)
  );
}
