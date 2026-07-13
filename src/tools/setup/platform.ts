/**
 * VS Code-free platform adapter for setup tools.
 *
 * Setup tools live in the `@tools/*` VS Code-free zone. Their common
 * credential and configuration capabilities derive from the shared platform;
 * only VS Code-specific interactions are supplied by the extension host.
 *
 * Keep this interface narrow — add methods only when a setup tool needs them.
 */

// Local imports
import { platform as currentPlatform } from '@platform/platform';
import { SupabaseClient } from '@auth/SupabaseClient';
import {
  fetchRelayTokenStatus,
  getConfiguredRelayToken,
} from '@auth/relayToken';
import type { TerminalRunResult, TerminalRunner } from '@hosts/uiHosts';
import {
  API_PROVIDERS,
  apiKeyExists,
  apiKeySecretName,
  hasUsableApiKey,
  type ApiProvider,
} from '@model/apiProviders';
import { hasUsableSetupCredential } from '@model/setupCredentialAccess';
import { resolveGitHubTokenSource } from '@tools/github/githubAuth';

/** Per-provider API key surface. */
export interface SetupSecretsAdapter {
  setApiKey(provider: ApiProvider, key: string): Promise<void>;
  deleteApiKey(provider: ApiProvider): Promise<void>;
  apiKeyExists(provider: ApiProvider): Promise<boolean>;
  /**
   * Like `apiKeyExists` but rejects empty values. A stale
   * `PROVIDER_API_KEY=""` env var is "present" but unusable at launch,
   * so setup-readiness checks must use this helper rather than raw
   * `apiKeyExists` to avoid misleading the agent (and the user).
   */
  hasUsableApiKey(provider: ApiProvider): Promise<boolean>;
  /**
   * Like `apiKeyExists` but only reports persisted entries — ignores
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
export interface SetupCommandAdapter {
  invoke(commandId: string, ...args: unknown[]): Promise<unknown>;
}

/** Extension host surface. */
export interface SetupExtensionAdapter {
  isInstalled(extensionId: string): boolean;
  install(extensionId: string): Promise<void>;
}

/** Auth / Researcher Access surface. */
export interface SetupAuthAdapter {
  getStatus(): Promise<{
    authenticated: boolean;
    remoteAgentCatalogAvailable: boolean;
    email?: string;
    tier?: string;
  }>;
  /** Start the host's existing TeXRA account sign-in flow, when available. */
  signIn?: () => Promise<boolean>;
}

/** Configuration-value surface. Reads/writes scoped to `texra.*` keys. */
export interface SetupConfigAdapter {
  /** Read the effective value of a `texra.*` setting. */
  get(key: string): unknown;
  /** Write a `texra.*` setting. `target` selects user vs. workspace scope. */
  update(
    key: string,
    value: unknown,
    target: 'user' | 'workspace',
  ): Promise<void>;
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
export type SetupTerminalAdapter = TerminalRunner;
export type { TerminalRunResult };

/** Aggregated setup platform. */
export interface SetupPlatform {
  secrets: SetupSecretsAdapter;
  auth: SetupAuthAdapter;
  config: SetupConfigAdapter;
  /** VS Code-only command invocation. */
  commands?: SetupCommandAdapter;
  /** VS Code extension inspection and installation. */
  extensions?: SetupExtensionAdapter;
  /** VS Code integrated-terminal execution. */
  terminal?: SetupTerminalAdapter;
}

/** Setup tools that require a VS Code-specific adapter. */
export const SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES = [
  'invoke_command',
  'install_vscode_extension',
  'send_to_terminal',
] as const;

function assertTexraScopedKey(key: string): void {
  if (!key.startsWith('texra.')) {
    throw new Error(
      `Setup config adapter is scoped to texra.* keys; refused: ${key}`,
    );
  }
}

async function defaultAuthStatus(): Promise<{
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
  const remoteAgentCatalogAvailable =
    await SupabaseClient.canAccessRemoteAgentCatalog();
  if (!authenticated) {
    return { authenticated: false, remoteAgentCatalogAvailable: false };
  }

  const [user, tier] = await Promise.all([
    SupabaseClient.getUser(),
    SupabaseClient.getUserTier(),
  ]);
  return {
    authenticated: true,
    remoteAgentCatalogAvailable,
    email: user?.email,
    tier,
  };
}

/**
 * Derive setup capabilities shared by every host from their existing platform
 * ports. This is the sole owner of the common setup wiring; hosts add only
 * capabilities that cannot exist outside VS Code.
 */
export function createDefaultSetupPlatform(): SetupPlatform {
  const services = currentPlatform();
  const { secrets, config } = services;

  return {
    secrets: {
      providers: API_PROVIDERS,
      setApiKey: (provider, key) =>
        secrets.set(apiKeySecretName(provider), key),
      deleteApiKey: (provider) => secrets.delete(apiKeySecretName(provider)),
      apiKeyExists: (provider) => apiKeyExists(secrets, provider),
      hasUsableApiKey: (provider) => hasUsableApiKey(secrets, provider),
      storedApiKeyExists: async (provider) =>
        (await secrets.listStoredKeys()).includes(apiKeySecretName(provider)),
      anyUsableCredentialExists: () => hasUsableSetupCredential(secrets),
      gitHubTokenExists: () => resolveGitHubTokenSource(secrets),
      listStoredKeys: () => secrets.listStoredKeys(),
    },
    auth: { getStatus: defaultAuthStatus },
    config: {
      get: (key) => {
        assertTexraScopedKey(key);
        return config.get(key);
      },
      update: async (key, value, target) => {
        assertTexraScopedKey(key);
        await config.update(
          key,
          value,
          target === 'workspace' ? 'workspace' : 'global',
        );
      },
    },
  };
}

let override: SetupPlatform | undefined;

/** Register host-specific setup capabilities, usually from `extension.ts`. */
export function setSetupPlatform(impl: SetupPlatform): void {
  override = impl;
}

/** Get host overrides when present, otherwise derive the common default. */
export function getSetupPlatform(): SetupPlatform {
  return override ?? createDefaultSetupPlatform();
}

/** Test support for exercising the host-neutral default after an override. */
export function __resetSetupPlatformForTests(): void {
  override = undefined;
}
