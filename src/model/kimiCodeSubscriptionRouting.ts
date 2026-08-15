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
import { includedModelAccess } from './includedModelAccess';
import { zeroCostAccessOverrides } from './subscriptionAccessOverrides';

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
 * Decide whether this model routes through the Kimi Code endpoint. Returns
 * `'kimiCode'` to route there (with the `kimiCode` credential), or `null` to
 * use the normal provider ladder.
 *
 *  - not eligible → `null`
 *  - exclusive → `'kimiCode'` when a key is set, else `null` (no other backend)
 *  - dual-backend → `'kimiCode'` only when the OpenRouter toggle is off, the
 *    relay is not serving the request (included access off or unavailable),
 *    the "Prefer Kimi Code" switch is on, and a key is set; otherwise `null`
 *    (falls back to the Moonshot open platform or the relay). The relay guard
 *    keeps credential resolution coherent: a rerouted config pins the coding
 *    `baseUrl`, which outranks the relay URL in `resolveBaseUrl` and would
 *    send the relay token to the wrong host.
 */
export function resolveKimiCodeRoute(
  config: KimiSubscriptionModelFields,
  useOpenRouter: boolean,
  keySet: boolean,
  preferKimiCode: boolean,
  includedAccess: boolean,
): 'kimiCode' | null {
  if (!isKimiSubscriptionEligible(config)) return null;
  if (isKimiCodeExclusiveModel(config)) {
    return keySet ? 'kimiCode' : null;
  }
  if (useOpenRouter || includedAccess || !preferKimiCode || !keySet) {
    return null;
  }
  return 'kimiCode';
}

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
  /** Whether included (relay) access is switched on and can serve the model. */
  readonly includedAccess: boolean;
}

/**
 * Whether the shared route resolver picks the Kimi Code endpoint under the
 * given host facts. Single home of the `resolveKimiCodeRoute(...) ===
 * 'kimiCode'` comparison so the predicate's meaning is written once.
 */
export function isKimiCodeRoute(
  config: KimiSubscriptionModelFields,
  facts: KimiCodeRoutingFacts,
): boolean {
  return (
    resolveKimiCodeRoute(
      config,
      facts.useOpenRouter,
      facts.keySet,
      facts.preferKimiCode,
      facts.includedAccess,
    ) === 'kimiCode'
  );
}

/**
 * Assemble the routing facts from the host: included access switched on and
 * able to serve the model (relay ownership gate), a stored Kimi Code key, and
 * the "Prefer Kimi Code" switch. `useOpenRouter` is passed in because the
 * dispatch path derives it from the persisted compatibility key while the
 * availability/subscription paths read the live toggle — the two sites that
 * used to duplicate this assembly inline.
 */
export async function resolveKimiCodeRoutingFacts(
  useOpenRouter: boolean,
): Promise<KimiCodeRoutingFacts> {
  const included = includedModelAccess();
  // The relay only owns the model when included access can actually serve it.
  const includedAccess = included.getUseIncludedModelAccess()
    ? await included.canUseServerSideKeys()
    : false;
  return {
    useOpenRouter,
    keySet: await hasUsableApiKey(platform().secrets, 'kimiCode'),
    preferKimiCode: getPreferKimiCode(),
    includedAccess,
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
 * Synthesize the runtime config for a dual-backend model routed through the
 * coding endpoint: pin the coding `baseUrl`, swap the display `fullName`/
 * `shortName` for the coding wire id, and align pricing/context with the
 * membership endpoint — usage is covered by the membership (zero per-token
 * price), and the context budget is the conservative tier cap rather than the
 * open platform's advertised 1M. Exclusive models already carry the pinned
 * `baseUrl`, zero price, and 256K window from the registry, so this is only
 * applied to dual-backend routes in practice.
 */
export function kimiCodeRuntimeConfig(config: ModelConfig): ModelConfig {
  const wireId = kimiCodeWireModelId(config);
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

/**
 * The config a Kimi-subscription-eligible model actually runs with under the
 * given routing facts: when the route resolver picks the Kimi Code endpoint
 * for a dual-backend model, swap in the synthesized runtime config (coding
 * base URL + wire id); exclusive models already carry the pinned config, so
 * they keep `config` untouched. Shared by the dispatch path (ModelFactory) and
 * the availability path (computeModelOptions) so both apply the identical
 * post-route synthesis.
 */
export function kimiCodeEffectiveConfig(
  config: ModelConfig,
  facts: KimiCodeRoutingFacts,
): ModelConfig {
  if (!isKimiCodeRoute(config, facts)) return config;
  return isKimiCodeExclusiveModel(config)
    ? config
    : kimiCodeRuntimeConfig(config);
}
