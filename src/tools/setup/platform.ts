/**
 * VS Code-free platform adapter for setup tools.
 *
 * Setup tools live in the `@tools/*` VS Code-free zone. Their common
 * credential and configuration capabilities derive directly from the shared
 * platform; hosts install only the capabilities that actually vary.
 *
 * Keep this interface narrow — add methods only when a setup tool needs them.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import type { ToolHost } from '@agent/core/tools/ToolTypes';
import { getCodexStatus } from '@auth/codex';
import { SupabaseClient } from '@auth/SupabaseClient';
import { hostPort } from '@common/hostPort';
import type { TerminalRunner } from '@hosts/uiHosts';
import { createLog } from '@logger/logUtils';
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
import { workspaceRoots } from '@platform/workspaceRoots';
import { resolveGitHubTokenSource } from '@tools/github/githubAuth';

const credentialLog = createLog('Setup Credentials');

/** Per-provider API key surface. */
interface SetupSecretsAdapter {
  deleteApiKey(provider: ApiProvider): Effect.Effect<void, unknown>;
  /**
   * Whether a usable key is resolved for the provider (secret storage, then
   * environment; blank values already filtered — see `hasUsableApiKey` in
   * `@model/apiProviders`). Named for the launch/retry-readiness call sites
   * here, which want the "is this actually usable" framing.
   */
  hasUsableApiKey(provider: ApiProvider): Effect.Effect<boolean, unknown>;
  /** Whether a usable key comes from TeXRA secrets, the environment, or neither. */
  apiKeyOrigin(provider: ApiProvider): Effect.Effect<ApiKeyOrigin, unknown>;
  /**
   * Unlike `hasUsableApiKey`, only reports persisted entries — ignores
   * environment-variable-backed keys. Needed by `unset_api_key` so the
   * agent doesn't claim to have removed a key that still comes from
   * `PROVIDER_API_KEY` in the user's shell.
   */
  storedApiKeyExists(provider: ApiProvider): Effect.Effect<boolean, unknown>;
  /** True when any credential can launch a setup model right now. */
  anyUsableCredentialExists(): Effect.Effect<boolean, unknown>;
  gitHubTokenExists(): Effect.Effect<'secret' | 'env' | 'none', unknown>;
  /** List of provider names known to TeXRA. */
  providers: readonly ApiProvider[];
  /**
   * All persisted secret key names. Values are never returned — only names.
   */
  listStoredKeys(): Effect.Effect<readonly string[], unknown>;
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

/** Host-varying setup capabilities. */
export interface SetupPlatform {
  /** Product surface currently running the shared setup agent. */
  host: ToolHost;
  /** Start the host's existing TeXRA account sign-in flow. */
  signIn: () => Promise<boolean>;
  /** VS Code-only command invocation. */
  commands?: SetupCommandAdapter;
  /** VS Code extension inspection and installation. */
  extensions?: SetupExtensionAdapter;
  /** VS Code integrated-terminal execution. */
  terminal?: TerminalRunner;
}

/**
 * The scope violation for a non-`texra.*` key, or `undefined` when the key is
 * in scope. Returned rather than thrown so the synchronous reader can throw it
 * while the update program fails with it in the error channel.
 */
function texraScopeViolation(key: string): Error | undefined {
  return key.startsWith('texra.')
    ? undefined
    : new Error(
        `Setup config adapter is scoped to texra.* keys; refused: ${key}`,
      );
}

/** TeXRA account status shared by every host. */
export const getSetupAuthStatus = Effect.fn('getSetupAuthStatus')(
  function* (): Effect.fn.Return<
    { authenticated: boolean; email?: string },
    unknown
  > {
    const authenticated = yield* hostPort(() =>
      SupabaseClient.isAuthenticated(),
    );
    if (!authenticated) {
      return { authenticated: false };
    }

    const user = yield* hostPort(() => SupabaseClient.getUser());
    return { authenticated: true, email: user?.email };
  },
);

/** Value-free credential capability exposed to setup tools. */
export const setupSecrets: SetupSecretsAdapter =
  Object.freeze<SetupSecretsAdapter>({
    providers: API_PROVIDERS,
    deleteApiKey: (provider) =>
      hostPort(() =>
        currentPlatform().secrets.delete(apiKeySecretName(provider)),
      ),
    hasUsableApiKey: (provider) =>
      hostPort(() => hasUsableApiKey(currentPlatform().secrets, provider)),
    apiKeyOrigin: (provider) =>
      hostPort(() => lookupApiKeyOrigin(currentPlatform().secrets, provider)),
    storedApiKeyExists: (provider) =>
      hostPort(() => currentPlatform().secrets.listStoredKeys()).pipe(
        Effect.map((keys) => keys.includes(apiKeySecretName(provider))),
      ),
    anyUsableCredentialExists: () =>
      hostPort(() =>
        hasUsableSetupCredential(currentPlatform().secrets, credentialLog.warn),
      ),
    gitHubTokenExists: () =>
      hostPort(() => resolveGitHubTokenSource(currentPlatform().secrets)),
    listStoredKeys: () =>
      hostPort(() => currentPlatform().secrets.listStoredKeys()),
  });

/** Subscription access reported separately from provider API keys. */
export const getChatGptSubscriptionStatus = Effect.fn(
  'getChatGptSubscriptionStatus',
)(function* (): Effect.fn.Return<
  { signedIn: boolean; enabled: boolean },
  unknown
> {
  const status = yield* hostPort(() => getCodexStatus());
  // Routing is only consulted for a signed-in account, as the `&&` did.
  if (!status.signedIn) return { signedIn: false, enabled: false };
  const enabled = yield* hostPort(() =>
    isCodexSubscriptionActive(CHATGPT_SETUP_MODEL),
  );
  return { signedIn: true, enabled };
});

/** Configuration operations scoped to `texra.*` keys. */
export const texraScopedConfig = Object.freeze({
  get(key: string): unknown {
    const violation = texraScopeViolation(key);
    if (violation) throw violation;
    return workspaceRoots().config.get(key);
  },
  update: Effect.fn('texraScopedConfig.update')(function* (
    key: string,
    value: unknown,
    target: 'user' | 'workspace',
  ): Effect.fn.Return<void, unknown> {
    const violation = texraScopeViolation(key);
    if (violation) return yield* Effect.fail(violation);
    yield* hostPort(() =>
      workspaceRoots().config.update(
        key,
        value,
        target === 'workspace' ? 'workspace' : 'global',
      ),
    );
  }),
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
