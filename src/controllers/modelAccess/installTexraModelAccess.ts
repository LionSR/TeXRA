/**
 * Wires TeXRA's account plane into the model layer.
 *
 * The model layer resolves credentials from `platform().secrets` and knows
 * nothing about TeXRA's Supabase subscription relay or its "Sign in with
 * ChatGPT" flow. This module is the one place those two planes are handed to
 * it, and every host composition root calls it next to `initPlatform()`. Skip
 * the call and the model layer runs bring-your-own-key — which is exactly what
 * an embedder of the agent core gets.
 */

import { ReasoningEffort } from 'llm-zoo';
import { getCodexStatus } from '@auth/codex';
import { getXaiStatus } from '@auth/xai';
import { SupabaseClient } from '@auth/SupabaseClient';
import { FREE_TIER, MAX_TIER } from '@auth/config';
import { getServerSideKeyService } from '@auth/serverKeys';
import {
  setIncludedModelAccess,
  type IncludedModelAccess,
} from '@model/includedModelAccess';
import { isGpt5ModelName } from '@model/modelNames';
import { setCodexSignedInProbe } from '@model/codex/codexSignedIn';
import { setXaiSignedInProbe } from '@model/xai/xaiSignedIn';

/**
 * Tier caps on GPT-5 reasoning effort for relay-served requests. The
 * above-high tiers cost far more per request than the tier prices in, so
 * included access serves them at the tier's ceiling instead of refusing the
 * model. Ultra (and any unknown tier) is uncapped.
 */
function capIncludedReasoningEffort(
  modelName: string,
  effort: ReasoningEffort,
): ReasoningEffort {
  if (
    !isGpt5ModelName(modelName) ||
    (effort !== ReasoningEffort.XHIGH && effort !== ReasoningEffort.MAX)
  ) {
    return effort;
  }
  switch (getServerSideKeyService().getUserTier()) {
    case MAX_TIER:
      return ReasoningEffort.HIGH;
    case FREE_TIER:
      return ReasoningEffort.MEDIUM;
    default:
      return effort;
  }
}

/**
 * TeXRA's included access: the Supabase-backed subscription relay.
 *
 * Every member re-reads `getServerSideKeyService()` rather than capturing it,
 * because the service is a lazily constructed singleton that sign-in and tests
 * replace after this object is installed.
 */
const TEXRA_INCLUDED_MODEL_ACCESS: IncludedModelAccess = {
  getUseIncludedModelAccess: () =>
    getServerSideKeyService().getUseIncludedModelAccess(),
  isAuthenticated: () => SupabaseClient.isAuthenticated(),
  canUseServerSideKeys: () => getServerSideKeyService().canUseServerSideKeys(),
  canUseModelSync: (modelName) =>
    getServerSideKeyService().canUseModelSync(modelName),
  isProviderOnServer: (provider) =>
    getServerSideKeyService().isProviderOnServer(provider),
  shouldUseServerSideKeysSync: (provider, modelName) =>
    getServerSideKeyService().shouldUseServerSideKeysSync(provider, modelName),
  wasQuotaAutoSwitched: () => getServerSideKeyService().wasQuotaAutoSwitched(),
  isRelayQuotaExceeded: () => getServerSideKeyService().isRelayQuotaExceeded(),
  getRelayBaseUrl: (provider) =>
    getServerSideKeyService().getRelayBaseUrl(provider),
  getAccessToken: (forceRefresh) =>
    SupabaseClient.getRelayAccessToken(forceRefresh),
  isAccessTokenExpiringSoon: () => SupabaseClient.isTokenExpiringSoon(),
  capReasoningEffort: capIncludedReasoningEffort,
};

/**
 * Install TeXRA's included (relay) access and ChatGPT / Grok sign-in state into
 * the model layer. Idempotent; call once per process from the host composition
 * root, immediately after `initPlatform()`.
 */
export function installTexraModelAccess(): void {
  setIncludedModelAccess(TEXRA_INCLUDED_MODEL_ACCESS);
  setCodexSignedInProbe(async () => (await getCodexStatus()).signedIn);
  setXaiSignedInProbe(async () => (await getXaiStatus()).signedIn);
}
