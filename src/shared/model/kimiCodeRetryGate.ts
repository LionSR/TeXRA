/**
 * Browser-safe Kimi Code subscription model facts.
 *
 * The pure field-level predicates below are the single source for Kimi Code
 * eligibility/exclusivity. Host-side route resolution
 * (`@model/modelRoute`) imports them, and the retry owner reads a Kimi Code
 * model's fallback off that route decision. This module is deliberately free
 * of platform/secret-store imports.
 */
import { ModelProvider } from 'llm-zoo';

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
