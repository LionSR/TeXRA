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
 *    differs (`kimi-k3` → `k3`, see {@link KIMI_CODE_WIRE_MODEL_IDS}).
 */

import { type ModelConfig } from 'llm-zoo';

import { platform } from '@platform/platform';
import { KIMI_CODE_BASE_URL } from '@shared/constants/providers';
import {
  isKimiCodeExclusiveModel,
  isKimiSubscriptionEligible,
  type KimiSubscriptionModelFields,
} from '@shared/model/kimiCodeRetryGate';
import { getPreferKimiCode } from '@utils/config/providerConfig';

import { hasUsableApiKey } from './apiProviders';
import { zeroCostAccessOverrides } from './subscriptionAccessOverrides';

/**
 * Open-platform `fullName` → coding-endpoint wire ID. Exclusive plan aliases
 * already use their wire ID as `fullName` and pass through unchanged.
 */
const KIMI_CODE_WIRE_MODEL_IDS: Readonly<Record<string, string>> = {
  'kimi-k3': 'k3',
};

/**
 * The host facts the Kimi Code route decision depends on, assembled once by
 * {@link resolveKimiCodeRoutingFacts} and threaded through the decision and
 * config-synthesis helpers so the three call sites (ModelFactory dispatch,
 * picker availability, subscription-active gate) cannot assemble them
 * differently.
 */
export interface KimiCodeRoutingFacts {
  /** Whether OpenRouter routing is active (live toggle, or derived from the
   * compatibility key on the resume path). */
  readonly useOpenRouter: boolean;
  /** Whether a Kimi Code console API key is stored. */
  readonly keySet: boolean;
  /** Whether the "Prefer Kimi Code" switch is on. */
  readonly preferKimiCode: boolean;
}

/**
 * Whether this model routes through the Kimi Code endpoint under the given
 * host facts. Single home of the decision so the dispatch and availability
 * paths cannot drift.
 *
 *  - not eligible → false
 *  - exclusive → routes whenever a key is set (no other backend exists)
 *  - dual-backend → routes only when the OpenRouter toggle is off, the
 *    "Prefer Kimi Code" switch is on, and a key is set; otherwise it stays on
 *    the Moonshot open platform.
 */
export function isKimiCodeRoute(
  config: KimiSubscriptionModelFields,
  facts: KimiCodeRoutingFacts,
): boolean {
  if (!isKimiSubscriptionEligible(config)) return false;
  if (isKimiCodeExclusiveModel(config)) return facts.keySet;
  return !facts.useOpenRouter && facts.preferKimiCode && facts.keySet;
}

/**
 * Assemble the routing facts from the host: a stored Kimi Code key and the
 * "Prefer Kimi Code" switch. `useOpenRouter` is passed in because the
 * dispatch path derives it from the persisted compatibility key while the
 * availability/subscription paths read the live toggle — the two sites that
 * used to duplicate this assembly inline.
 */
export async function resolveKimiCodeRoutingFacts(
  useOpenRouter: boolean,
): Promise<KimiCodeRoutingFacts> {
  return {
    useOpenRouter,
    keySet: await hasUsableApiKey(platform().secrets, 'kimiCode'),
    preferKimiCode: getPreferKimiCode(),
  };
}

/**
 * Conservative context budget on the coding endpoint: the Moderato tier serves
 * 256K; only Allegretto+ unlocks 1M on `k3`. The open-platform registry entry
 * advertises the full 1M, so cap it here — overstating the window breaks
 * compaction budgets for Moderato members.
 */
const KIMI_CODE_SUBSCRIPTION_CONTEXT_WINDOW = 262_144;

/**
 * The config a Kimi-subscription-eligible model actually runs with under the
 * given routing facts. When the route lands on the Kimi Code endpoint for a
 * dual-backend model, synthesize the runtime config: pin the coding `baseUrl`,
 * swap the display `fullName`/`shortName` for the coding wire id, and align
 * pricing/context with the membership endpoint — usage is covered by the
 * membership (zero per-token price), and the context budget is the
 * conservative tier cap rather than the open platform's advertised 1M.
 * Exclusive models already carry the pinned `baseUrl`, zero price and 256K
 * window from the registry, so they keep `config` untouched. Shared by the
 * dispatch path (ModelFactory) and the availability path
 * (computeModelOptions) so both apply the identical post-route synthesis.
 */
export function kimiCodeEffectiveConfig(
  config: ModelConfig,
  facts: KimiCodeRoutingFacts,
): ModelConfig {
  if (!isKimiCodeRoute(config, facts)) return config;
  if (isKimiCodeExclusiveModel(config)) return config;
  const wireId = KIMI_CODE_WIRE_MODEL_IDS[config.fullName] ?? config.fullName;
  return {
    ...config,
    fullName: wireId,
    shortName: wireId,
    baseUrl: KIMI_CODE_BASE_URL,
    ...zeroCostAccessOverrides(
      Math.min(KIMI_CODE_SUBSCRIPTION_CONTEXT_WINDOW, config.contextWindow),
    ),
  };
}
