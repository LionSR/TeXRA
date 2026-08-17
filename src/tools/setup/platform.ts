/**
 * VS Code-free platform adapter for setup tools.
 *
 * Setup tools live in the `@tools/*` VS Code-free zone. Their common
 * credential and configuration capabilities derive directly from the shared
 * platform; hosts install only the capabilities that actually vary.
 *
 * Keep this interface narrow — add methods only when a setup tool needs them.
 */

// Local imports
import type { ToolHost } from '@agent/core/tools/ToolTypes';
import {
  fetchRelayTokenStatus,
  getConfiguredRelayToken,
} from '@auth/relayToken';
import { getCodexStatus } from '@auth/codex';
import { SupabaseClient } from '@auth/SupabaseClient';
import type { TerminalRunResult, TerminalRunner } from '@hosts/uiHosts';
import {
  API_PROVIDERS,
  apiKeySecretName,
  hasUsableApiKey,
  lookupApiKeyOrigin,
  type ApiKeyOrigin,
  type ApiProvider,
} from '@model/apiProviders';
import { hasUsableSetupCredential } from '@model/setupCredentialAccess';
import { isCodexSubscriptionActive } from '@model/providerCapabilities';
import { CHATGPT_SETUP_MODEL } from '@model/setupModelDefaults';
import { platform as currentPlatform } from '@platform/platform';
import { resolveGitHubTokenSource } from '@tools/github/githubAuth';

/** Per-provider API key surface. */
export interface SetupSecretsAdapter {
  deleteApiKey(provider: ApiProvider): Promise<void>;
  /**
   * Whether a usable key is resolved for the provider (secret storage, then
   * environment; blank values already filtered — see `hasUsableApiKey` in
   * `@model/apiProviders`). Named for the launch/retry-readiness call sites
   * here, which want the "is this actually usable" framing.
   */
  hasUsableApiKey(provider: ApiProvider): Promise<boolean>;
  /** Whether a usable key comes from TeXRA secrets, the environment, or neither. */
  apiKeyOrigin(provider: ApiProvider): Promise<ApiKeyOrigin>;
  /**
   * Unlike `hasUsableApiKey`, only reports persisted entries — ignores
   * environment-variable-backed keys. Needed by `unset_api_key` so the
   * agent doesn't claim to have removed a key that still comes from
   * `PROVIDER_API_KEY` in the user's shell.
   */
  storedApiKeyExists(provider: ApiProvider): Promise<boolean>;
  /** True when any credential can launch a setup model right now. */
  anyUsableCredentialExists(): Promise<boolean>;
  gitHubTokenExists(): Promise<'secret' | 'env' | 'none'>;
  /** List of provider names known to TeXRA. */
  providers: readonly ApiProvider[];
  /**
   * All persisted secret key names. Values are never returned — only names.
   */
  listStoredKeys(): Promise<readonly string[]>;
}

/** Per-command surface. */
interface SetupCommandAdapter {
  invoke(commandId: string, ...args: unknown[]): Promise<unknown>;
}

/** Extension host surface. */
interface SetupExtensionAdapter {
  isInstalled(extensionId: string): boolean;
  install(extensionId: string): Promise<void>;
}

/**
 * Integrated-terminal surface. The setup agent uses this for commands
 * the captured-stdio `bash` tool cannot handle: `sudo` password prompts,
 * other interactive TTY prompts, and any flow where the user must type
 * into the running process.
 *
 * Implementations should prefer VS Code's stable `Terminal.shellIntegration`
 * API (since 1.93) so the agent can read back exit code + output. When
 * shell integration is unavailable the implementation may return an
 * `undefined` exit code with empty output — the caller treats that the
 * same as "user interrupted", since neither path tells us anything
 * actionable.
 */
export type { TerminalRunResult };

export type SetupHost = ToolHost;

/** Host-varying setup capabilities. */
export interface SetupPlatform {
  /** Product surface currently running the shared setup agent. */
  host: SetupHost;
  /** Start the host's existing TeXRA account sign-in flow. */
  signIn: () => Promise<boolean>;
  /** VS Code-only command invocation. */
  commands?: SetupCommandAdapter;
  /** VS Code extension inspection and installation. */
  extensions?: SetupExtensionAdapter;
  /** VS Code integrated-terminal execution. */
  terminal?: TerminalRunner;
}

function assertTexraScopedKey(key: string): void {
  if (!key.startsWith('texra.')) {
    throw new Error(
      `Setup config adapter is scoped to texra.* keys; refused: ${key}`,
    );
  }
}

/** Researcher Access status shared by every host. */
export async function getSetupAuthStatus(): Promise<{
  authenticated: boolean;
  remoteAgentCatalogAvailable: boolean;
  email?: string;
  tier?: string;
}> {
  const relayToken = getConfiguredRelayToken();
  if (relayToken) {
    // Prime the relay-status cache that isAuthenticated() consults below.
    await fetchRelayTokenStatus(relayToken);
  }

  const authenticated = await SupabaseClient.isAuthenticated();
  if (!authenticated) {
    return { authenticated: false, remoteAgentCatalogAvailable: false };
  }

  const [user, tier, remoteAgentCatalogAvailable] = await Promise.all([
    SupabaseClient.getUser(),
    SupabaseClient.getUserTier(),
    SupabaseClient.canAccessRemoteAgentCatalog(),
  ]);
  return {
    authenticated: true,
    remoteAgentCatalogAvailable,
    email: user?.email,
    tier,
  };
}

/** Value-free credential capability exposed to setup tools. */
export const setupSecrets: SetupSecretsAdapter =
  Object.freeze<SetupSecretsAdapter>({
    providers: API_PROVIDERS,
    deleteApiKey: (provider) =>
      currentPlatform().secrets.delete(apiKeySecretName(provider)),
    hasUsableApiKey: (provider) =>
      hasUsableApiKey(currentPlatform().secrets, provider),
    apiKeyOrigin: (provider) =>
      lookupApiKeyOrigin(currentPlatform().secrets, provider),
    storedApiKeyExists: async (provider) =>
      (await currentPlatform().secrets.listStoredKeys()).includes(
        apiKeySecretName(provider),
      ),
    anyUsableCredentialExists: () =>
      hasUsableSetupCredential(currentPlatform().secrets),
    gitHubTokenExists: () =>
      resolveGitHubTokenSource(currentPlatform().secrets),
    listStoredKeys: () => currentPlatform().secrets.listStoredKeys(),
  });

/** Subscription access reported separately from provider API keys. */
export async function getChatGptSubscriptionStatus(): Promise<{
  signedIn: boolean;
  enabled: boolean;
}> {
  const status = await getCodexStatus();
  return {
    signedIn: status.signedIn,
    enabled:
      status.signedIn && (await isCodexSubscriptionActive(CHATGPT_SETUP_MODEL)),
  };
}

/** Configuration operations scoped to `texra.*` keys. */
export const texraScopedConfig = Object.freeze({
  get(key: string): unknown {
    assertTexraScopedKey(key);
    return currentPlatform().config.get(key);
  },
  async update(
    key: string,
    value: unknown,
    target: 'user' | 'workspace',
  ): Promise<void> {
    assertTexraScopedKey(key);
    await currentPlatform().config.update(
      key,
      value,
      target === 'workspace' ? 'workspace' : 'global',
    );
  },
});

let override: SetupPlatform | undefined;

/** Register host-specific setup capabilities, usually from `extension.ts`. */
export function setSetupPlatform(impl: SetupPlatform): void {
  override = impl;
}

/** Get the setup platform installed by the active host composition root. */
export function getSetupPlatform(): SetupPlatform {
  if (!override) throw new Error('Setup platform has not been initialized.');
  return override;
}

/** Test support for exercising the host-neutral default after an override. */
export function __resetSetupPlatformForTests(): void {
  override = undefined;
}
