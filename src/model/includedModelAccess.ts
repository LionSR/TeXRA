/**
 * The "included model access" plane: an optional, app-supplied relay that
 * fronts provider APIs with the application's own credential instead of the
 * user's.
 *
 * The model layer must be able to run on nothing but an API key from
 * `platform().secrets` or the environment, so it owns the *question* — may this
 * model route through included access, at what URL, with what token — and never
 * the answer. TeXRA's Supabase-backed subscription relay is one implementation,
 * installed from the app side at startup (see
 * `src/controllers/modelAccess/installTexraModelAccess.ts`); an embedder that
 * installs nothing gets {@link BYOK_ONLY}.
 *
 * BYOK by default, and deliberately not "off only when nothing is configured":
 * routing a process's model traffic (and its billing) through someone else's
 * servers is not something a library may start doing because a state store
 * happened to be present. Included access exists for exactly as long as an app
 * has said so by installing a provider.
 */

import type { ModelProvider, ReasoningEffort } from 'llm-zoo';

/**
 * The relay plane as the model layer consults it. Every member is a question
 * the model layer already asked before this seam existed; nothing here is a
 * capability the model layer gained.
 */
export interface IncludedModelAccess {
  /** Whether the user has included access switched on at all. */
  getUseIncludedModelAccess(): boolean;
  /**
   * Whether an account session exists at all. Distinguishes "not signed in"
   * from "signed in but this tier does not cover the model", which
   * {@link canUseServerSideKeys} collapses into a single `false`.
   */
  isAuthenticated(): Promise<boolean>;
  /** Whether the account can currently use included access (may fetch). */
  canUseServerSideKeys(): Promise<boolean>;
  /** Whether the primed tier cache covers this model. */
  canUseModelSync(modelName: string): boolean;
  /** Whether included access serves this provider at all. */
  isProviderOnServer(provider: ModelProvider): boolean;
  /** Combined sync gate: switched on, provider served, model in tier. */
  shouldUseServerSideKeysSync(
    provider: ModelProvider,
    modelName?: string,
  ): boolean;
  /** Whether included access was just switched off by quota exhaustion. */
  wasQuotaAutoSwitched(): boolean;
  /** Whether the account's included-access quota is exhausted. */
  isRelayQuotaExceeded(): boolean;
  /** Base URL for this provider's requests through included access. */
  getRelayBaseUrl(provider: ModelProvider): string;
  /** Bearer credential for an included-access request, or `null` if unavailable. */
  getAccessToken(forceRefresh?: boolean): Promise<string | null>;
  /** Whether that credential is close enough to expiry to warrant a refresh. */
  isAccessTokenExpiringSoon(): boolean;
  /**
   * The effort the relay operator will actually honor for this model. Included
   * access can be sold in tiers that cap reasoning effort; a direct API key is
   * never capped, so this is asked only on the included-access route.
   */
  capReasoningEffort(
    modelName: string,
    effort: ReasoningEffort,
  ): ReasoningEffort;
}

/**
 * Bring-your-own-key: no included access of any kind. Every gate answers "no",
 * so the credential resolver falls through to `platform().secrets` and no
 * request can be addressed to a relay.
 */
const BYOK_ONLY: IncludedModelAccess = {
  getUseIncludedModelAccess: () => false,
  isAuthenticated: async () => false,
  canUseServerSideKeys: async () => false,
  canUseModelSync: () => false,
  isProviderOnServer: () => false,
  shouldUseServerSideKeysSync: () => false,
  wasQuotaAutoSwitched: () => false,
  isRelayQuotaExceeded: () => false,
  getRelayBaseUrl: (provider) => {
    // Unreachable behind the gates above. Throwing keeps it that way: a
    // fabricated URL here would silently address requests to nothing.
    throw new Error(
      `No included model access is installed, so there is no relay URL for "${provider}". ` +
        `${INCLUDED_MODEL_ACCESS_REMEDY}`,
    );
  },
  getAccessToken: async () => null,
  isAccessTokenExpiringSoon: () => false,
  capReasoningEffort: (_modelName, effort) => effort,
};

/**
 * Both ways out of a missing credential, for error messages. Named in full at
 * every failure so "no key" never reads as "this model is broken".
 */
export const INCLUDED_MODEL_ACCESS_REMEDY =
  'Set a provider API key, or enable included model access in this application.';

let installed: IncludedModelAccess | null = null;

/**
 * Install the app's included-access provider, or pass `null` to restore
 * bring-your-own-key. Called once per process from the host composition root,
 * next to `initPlatform()`.
 */
export function setIncludedModelAccess(
  access: IncludedModelAccess | null,
): void {
  installed = access;
}

/** The installed included-access provider, or bring-your-own-key. */
export function includedModelAccess(): IncludedModelAccess {
  return installed ?? BYOK_ONLY;
}
