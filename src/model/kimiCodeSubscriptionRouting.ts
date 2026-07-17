/**
 * The single route resolver that decides whether a model request should be
 * served by the Kimi Code (Moonshot coding-subscription) endpoint.
 *
 * Shared by the handler dispatch (ModelFactory) and the picker availability
 * gate (computeModelOptions) so they never drift: both consume the same
 * synchronous resolver with the same injected facts (whether a Kimi Code API
 * key is stored, and whether the "Prefer Kimi Code" switch is on).
 *
 * Two eligibility shapes:
 *  - **exclusive** models (`kimi-for-coding`, `kimi-for-coding-highspeed`) are
 *    served ONLY by the coding endpoint (llm-zoo pins their `baseUrl` to it) —
 *    they route there whenever a Kimi Code key is set, regardless of the
 *    OpenRouter or "Prefer Kimi Code" toggles, and never fall back;
 *  - **dual-backend** models (`kimi3`) also exist on the Moonshot open
 *    platform; rerouting them through the coding endpoint is opt-in via the
 *    "Prefer Kimi Code" switch and requires a stored key, and their wire ID
 *    differs (`kimi-k3` → `k3`, see {@link kimiCodeWireModelId}).
 */

import { ModelProvider, type ModelConfig } from 'llm-zoo';

/** OpenAI-compatible base URL for the Kimi Code coding endpoint. */
export const KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';

/**
 * Open-platform `fullName` → coding-endpoint wire ID. Exclusive plan aliases
 * already use their wire ID as `fullName` and pass through unchanged.
 */
const KIMI_CODE_WIRE_MODEL_IDS: Readonly<Record<string, string>> = {
  'kimi-k3': 'k3',
};

/** The model id the Kimi Code backend keys on. */
export function kimiCodeWireModelId(config: {
  readonly fullName: string;
}): string {
  return KIMI_CODE_WIRE_MODEL_IDS[config.fullName] ?? config.fullName;
}

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
 * Read directly from the llm-zoo `kimiSubscription` registry flag (added in
 * llm-zoo 1.19.x) — serving status is a fact about the Kimi Code backend, not
 * derivable from other model fields. Requires
 * `provider === ModelProvider.MOONSHOT`, asserted here since this function is
 * exported and a non-Moonshot config must never resolve eligible.
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
 * Decide whether this model routes through the Kimi Code endpoint. Returns
 * `'kimiCode'` to route there (with the `kimiCode` credential), or `null` to
 * use the normal provider ladder.
 *
 *  - not eligible → `null`
 *  - exclusive → `'kimiCode'` when a key is set, else `null` (no other backend)
 *  - dual-backend → `'kimiCode'` only when the OpenRouter toggle is off, the
 *    "Prefer Kimi Code" switch is on, and a key is set; otherwise `null`
 *    (falls back to the Moonshot open platform).
 */
export function resolveKimiCodeRoute(
  config: KimiSubscriptionModelFields,
  useOpenRouter: boolean,
  keySet: boolean,
  preferKimiCode: boolean,
): 'kimiCode' | null {
  if (!isKimiSubscriptionEligible(config)) return null;
  if (isKimiCodeExclusiveModel(config)) {
    return keySet ? 'kimiCode' : null;
  }
  if (useOpenRouter || !preferKimiCode || !keySet) return null;
  return 'kimiCode';
}

/**
 * Synthesize the runtime config for a dual-backend model routed through the
 * coding endpoint: pin the coding `baseUrl` and swap the display `fullName`/
 * `shortName` for the coding wire id. Exclusive models already carry the pinned
 * `baseUrl` and wire id from the registry, so this is a no-op-equivalent for
 * them, but is only applied to dual-backend routes in practice.
 */
export function kimiCodeRuntimeConfig(config: ModelConfig): ModelConfig {
  const wireId = kimiCodeWireModelId(config);
  return {
    ...config,
    fullName: wireId,
    shortName: wireId,
    baseUrl: KIMI_CODE_BASE_URL,
  };
}
