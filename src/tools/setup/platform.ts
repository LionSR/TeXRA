/**
 * VS Code-free platform adapter for setup tools.
 *
 * Setup tools live in the `@tools/*` VS Code-free zone. Their credential
 * capabilities are programs over the `Secrets` service; hosts provide only
 * the capabilities that actually vary, as the `SetupPlatform` service.
 *
 * Keep this interface narrow — add methods only when a setup tool needs them.
 */

// Third-party imports
import { Context, Effect, Layer } from 'effect';

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
import { Secrets } from '@platform/secrets';
import { workspaceRoots } from '@platform/workspaceRoots';
import { resolveGitHubTokenSource } from '@tools/github/githubAuth';

const credentialLog = createLog('Setup Credentials');

/** Per-provider API key surface: programs over the `Secrets` service. */
interface SetupSecretsAdapter {
  deleteApiKey(provider: ApiProvider): Effect.Effect<void, unknown, Secrets>;
  /**
   * Whether a usable key is resolved for the provider (secret storage, then
   * environment; blank values already filtered — see `hasUsableApiKey` in
   * `@model/apiProviders`). Named for the launch/retry-readiness call sites
   * here, which want the "is this actually usable" framing.
   */
  hasUsableApiKey(
    provider: ApiProvider,
  ): Effect.Effect<boolean, unknown, Secrets>;
  /** Whether a usable key comes from TeXRA secrets, the environment, or neither. */
  apiKeyOrigin(
    provider: ApiProvider,
  ): Effect.Effect<ApiKeyOrigin, unknown, Secrets>;
  /**
   * Unlike `hasUsableApiKey`, only reports persisted entries — ignores
   * environment-variable-backed keys. Needed by `unset_api_key` so the
   * agent doesn't claim to have removed a key that still comes from
   * `PROVIDER_API_KEY` in the user's shell.
   */
  storedApiKeyExists(
    provider: ApiProvider,
  ): Effect.Effect<boolean, unknown, Secrets>;
  /** True when any credential can launch a setup model right now. */
  anyUsableCredentialExists(): Effect.Effect<boolean, unknown, Secrets>;
  gitHubTokenExists(): Effect.Effect<
    'secret' | 'env' | 'none',
    unknown,
    Secrets
  >;
  /** List of provider names known to TeXRA. */
  providers: readonly ApiProvider[];
  /**
   * All persisted secret key names. Values are never returned — only names.
   */
  listStoredKeys(): Effect.Effect<readonly string[], unknown, Secrets>;
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
export interface SetupPlatformShape {
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
 * The host's setup capabilities as an Effect service
 * (`@texra/setup/SetupPlatform`, injection plan §5 row 13), provided once by
 * the composition root through `installProcessRuntime`; a setup tool reads
 * it with `yield* SetupPlatform`.
 */
export class SetupPlatform extends Context.Service<
  SetupPlatform,
  SetupPlatformShape
>()('@texra/setup/SetupPlatform') {
  static layer(setup: SetupPlatformShape): Layer.Layer<SetupPlatform> {
    return Layer.succeed(SetupPlatform)(setup);
  }
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
    deleteApiKey: Effect.fn('setupSecrets.deleteApiKey')(function* (
      provider: ApiProvider,
    ) {
      const secrets = yield* Secrets;
      yield* hostPort(() => secrets.delete(apiKeySecretName(provider)));
    }),
    hasUsableApiKey: Effect.fn('setupSecrets.hasUsableApiKey')(function* (
      provider: ApiProvider,
    ) {
      const secrets = yield* Secrets;
      return yield* hostPort(() => hasUsableApiKey(secrets, provider));
    }),
    apiKeyOrigin: Effect.fn('setupSecrets.apiKeyOrigin')(function* (
      provider: ApiProvider,
    ) {
      const secrets = yield* Secrets;
      return yield* hostPort(() => lookupApiKeyOrigin(secrets, provider));
    }),
    storedApiKeyExists: Effect.fn('setupSecrets.storedApiKeyExists')(function* (
      provider: ApiProvider,
    ) {
      const secrets = yield* Secrets;
      const keys = yield* hostPort(() => secrets.listStoredKeys());
      return keys.includes(apiKeySecretName(provider));
    }),
    anyUsableCredentialExists: Effect.fn(
      'setupSecrets.anyUsableCredentialExists',
    )(function* () {
      const secrets = yield* Secrets;
      return yield* hostPort(() =>
        hasUsableSetupCredential(secrets, credentialLog.warn),
      );
    }),
    gitHubTokenExists: Effect.fn('setupSecrets.gitHubTokenExists')(
      function* () {
        const secrets = yield* Secrets;
        return yield* hostPort(() => resolveGitHubTokenSource(secrets));
      },
    ),
    listStoredKeys: Effect.fn('setupSecrets.listStoredKeys')(function* () {
      const secrets = yield* Secrets;
      return yield* hostPort(() => secrets.listStoredKeys());
    }),
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
