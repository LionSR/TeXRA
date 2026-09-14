/**
 * VS Code-free platform adapter for setup tools.
 *
 * Setup tools live in the `@tools/*` VS Code-free zone. Each reads its
 * credentials from the `Secrets` service directly; hosts provide only the
 * capabilities that actually vary, as the `SetupPlatform` service.
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
import { isCodexSubscriptionActive } from '@model/providerCapabilities';
import { CHATGPT_SETUP_MODEL } from '@model/setupModelDefaults';
import { Secrets } from '@platform/secrets';

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

/** Subscription access reported separately from provider API keys. */
export const getChatGptSubscriptionStatus = Effect.fn(
  'getChatGptSubscriptionStatus',
)(function* (): Effect.fn.Return<
  { signedIn: boolean; enabled: boolean },
  unknown,
  Secrets
> {
  const secrets = yield* Secrets;
  const status = yield* hostPort(() => getCodexStatus(secrets));
  // Routing is only consulted for a signed-in account, as the `&&` did.
  if (!status.signedIn) return { signedIn: false, enabled: false };
  const enabled = yield* hostPort(() =>
    isCodexSubscriptionActive(CHATGPT_SETUP_MODEL),
  );
  return { signedIn: true, enabled };
});
