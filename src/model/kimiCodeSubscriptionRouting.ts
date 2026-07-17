/**
 * The single route resolver that decides whether a model request should be
 * served by the Kimi Code (Moonshot coding-subscription) endpoint, and with
 * which credential.
 *
 * Shared by the handler dispatch (ModelFactory), the handler's per-request
 * credential choice, and the picker availability gate (computeModelOptions) so
 * they never drift. Deliberately synchronous over injected credential facts —
 * the async "is the session routable / does the key exist" checks happen in
 * the availability context and at request time.
 *
 * Two eligibility shapes, unlike Codex:
 *  - **exclusive** models (`kimi-for-coding`, `kimi-for-coding-highspeed`) are
 *    served ONLY by the coding endpoint (llm-zoo pins their `baseUrl` to it) —
 *    they route there regardless of the OpenRouter toggle and never fall back;
 *  - **dual-backend** models (`kimi3`) also exist on the Moonshot open
 *    platform; rerouting them through the subscription is opt-in via the
 *    "prefer Kimi Code subscription" switch, and their wire ID differs
 *    (`kimi-k3` → `k3`, see {@link kimiCodeWireModelId}).
 */

import {
  KIMI_CODE_BASE_URL,
  isKimiCodeSubscriptionToolUseOnly,
  isPreferKimiCodeSubscription,
} from '@auth/kimiCode';
import { AgentCategory } from '@shared/schemas/agent';
import { ModelProvider, type ModelConfig } from 'llm-zoo';

import type { ProviderCapabilityProfile } from './providerCapabilities';

/**
 * Conservative context budget on the coding endpoint: the Moderato tier serves
 * 256K; only Allegretto+ unlocks 1M on `k3`. Overstating the window breaks
 * compaction budgets for Moderato users, so the lower tier wins until the
 * per-account `GET /coding/v1/models` context_length is consulted.
 */
export const KIMI_CODE_SUBSCRIPTION_CONTEXT_WINDOW = 262_144;

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
 * Whether `model` is eligible to route through the Kimi Code subscription
 * endpoint. Read directly from the llm-zoo `kimiSubscription` registry flag
 * (added in llm-zoo 1.19.x) — serving status is a fact about the Kimi Code
 * backend, not derivable from other model fields. Requires
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
  return isKimiSubscriptionEligible(model) && model.baseUrl === KIMI_CODE_BASE_URL;
}

/** Resolve the Kimi Code provider profile (zero-rate, tier-capped context). */
export function resolveKimiCodeProviderCapabilities(
  model: ModelConfig,
): ProviderCapabilityProfile {
  return {
    authMode: 'kimi-code-subscription',
    contextWindow: Math.min(
      KIMI_CODE_SUBSCRIPTION_CONTEXT_WINDOW,
      model.contextWindow,
    ),
    // Usage is covered by the membership (OAuth session or console key), not
    // per-token billing.
    inputPrice: 0,
    outputPrice: 0,
  };
}

/**
 * Whether the OAuth session may serve this request: the "prefer subscription"
 * switch is on, and the tool-use-only restriction (when set) matches the agent
 * category. The console API key is NOT gated here — it is a documented plain
 * credential for the same endpoint.
 */
export function isKimiCodeOAuthAllowedForAgentCategory(
  agentCategory: AgentCategory | undefined,
): boolean {
  if (!isPreferKimiCodeSubscription()) return false;
  if (!isKimiCodeSubscriptionToolUseOnly()) return true;
  return agentCategory === AgentCategory.ToolUse;
}

/** Credential facts resolved asynchronously by the caller. */
export interface KimiCodeCredentialFacts {
  /** A routable OAuth session exists AND the preference switch is on. */
  oauthReady: boolean;
  /** A Kimi Code console API key is stored. */
  keySet: boolean;
}

export type KimiCodeRoute = 'oauth' | 'api-key';

/**
 * Decide whether (and with which credential) this model routes through the
 * Kimi Code endpoint. Returns null when it should use the normal provider
 * ladder instead (dual-backend models) or has no usable credential.
 */
export function resolveKimiCodeRoute(
  config: ModelConfig,
  useOpenRouter: boolean,
  facts: KimiCodeCredentialFacts,
  agentCategory: AgentCategory | undefined,
): KimiCodeRoute | null {
  if (!isKimiSubscriptionEligible(config)) return null;
  const exclusive = isKimiCodeExclusiveModel(config);
  if (!exclusive) {
    // Dual-backend models defer to OpenRouter when the global toggle is on
    // (mirroring Codex), and rerouting them off the open platform is opt-in.
    if (useOpenRouter) return null;
    if (!isPreferKimiCodeSubscription()) return null;
  }
  if (facts.oauthReady && isKimiCodeOAuthAllowedForAgentCategory(agentCategory)) {
    return 'oauth';
  }
  return facts.keySet ? 'api-key' : null;
}
