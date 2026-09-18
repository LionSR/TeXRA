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
import { Context, Data, Effect, Layer } from 'effect';

// Local imports
import type { ToolHost } from '@agent/core/tools/ToolTypes';
import { getCodexStatus } from '@auth/codex';
import { SupabaseAuth } from '@auth/SupabaseAuth';
import type { SignInFailed } from '@common/errors/signInFailed';
import type { TerminalRunner } from '@hosts/uiHosts';
import { isCodexSubscriptionActive } from '@model/providerCapabilities';
import { CHATGPT_SETUP_MODEL } from '@model/setupModelDefaults';
import type { LanguageModel } from '@platform/languageModel';
import { Secrets } from '@platform/secrets';
import { ToolError } from '@shared/schemas';

/**
 * Why a host command invocation never ran to completion, read off what the
 * implementations raise: the agent package has no command surface at all,
 * and the VS Code host's own `executeCommand` rejects once a command is
 * dispatched. Callers match the tag and read `reason`, so "this host cannot
 * invoke commands" and "the command ran and faulted" stay distinguishable.
 */
export class SetupCommandFailed extends Data.TaggedError('SetupCommandFailed')<{
  readonly reason: 'command-unavailable' | 'command-failed';
  readonly message: string;
  readonly commandId: string;
  readonly cause?: unknown;
}> {}

/**
 * The one failure of {@link SetupExtensionAdapter.install}: the host refused
 * the install. There is no second reason, because a host without an
 * extension surface leaves `extensions` undefined rather than raising —
 * the caller already reports that absence itself.
 */
export class SetupExtensionInstallFailed extends Data.TaggedError(
  'SetupExtensionInstallFailed',
)<{
  readonly message: string;
  readonly extensionId: string;
  readonly cause?: unknown;
}> {}

/**
 * Per-command surface. The member is an `Effect`: a host fault reaches the
 * setup tool as {@link SetupCommandFailed} rather than as `unknown`, and
 * interrupting the fiber abandons the wait instead of holding an
 * uninterruptible region open.
 */
interface SetupCommandAdapter {
  invoke(
    commandId: string,
    ...args: unknown[]
  ): Effect.Effect<unknown, SetupCommandFailed>;
}

/**
 * Extension host surface. `isInstalled` stays synchronous — it is a registry
 * read, not a host call — while `install` is an `Effect` carrying
 * {@link SetupExtensionInstallFailed}.
 */
interface SetupExtensionAdapter {
  isInstalled(extensionId: string): boolean;
  install(
    extensionId: string,
  ): Effect.Effect<void, SetupExtensionInstallFailed>;
}

/** Host-varying setup capabilities. */
export interface SetupPlatformShape {
  /** Product surface currently running the shared setup agent. */
  host: ToolHost;
  /**
   * Start the host's existing TeXRA account sign-in flow. The member is an
   * `Effect`: a host that cannot run the flow reaches the setup tool as
   * `SignInFailed` rather than as `unknown`. The extension and desktop
   * implementations answer `false` when the user cancels; the CLI loopback
   * has no boolean cancel value and surfaces abandonment or timeout through
   * `SignInFailed`.
   */
  signIn: () => Effect.Effect<boolean, SignInFailed>;
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
 * Fail with a uniform, sorted-allowlist error when `id` is not a member of
 * `allowed`. Shared by the setup tools so a disallowed extension ID and a
 * disallowed command ID reject with the same wording, not two hand-rolled
 * copies of it.
 */
export function assertInSetupAllowlist(
  kind: string,
  id: string,
  allowed: ReadonlySet<string>,
): Effect.Effect<void, ToolError> {
  if (allowed.has(id)) return Effect.void;
  return Effect.fail(
    new ToolError(
      `${kind} "${id}" is not in the setup allowlist. Allowed: ${[...allowed].sort().join(', ')}.`,
    ),
  );
}

/** TeXRA account status shared by every host. */
export const getSetupAuthStatus = Effect.fn('getSetupAuthStatus')(function* () {
  const auth = yield* SupabaseAuth;
  // The account plane's probes settle their own failures to the signed-out
  // answer, so there is nothing to catch here.
  if (!(yield* auth.authenticated)) {
    return { authenticated: false };
  }
  const user = yield* auth.user;
  return { authenticated: true, email: user?.email };
});

/**
 * The ChatGPT subscription routing probe could not answer. It reads the
 * routing built from the stored OAuth session; it never reports "no
 * subscription" this way, which is a value. It stays `Promise`-shaped with
 * the rest of the account group.
 */
class SubscriptionProbeFailed extends Data.TaggedError(
  'SubscriptionProbeFailed',
)<{
  readonly member: 'isCodexSubscriptionActive';
  readonly message: string;
  readonly cause: unknown;
}> {}

/** Subscription access reported separately from provider API keys. */
export const getChatGptSubscriptionStatus = Effect.fn(
  'getChatGptSubscriptionStatus',
)(function* (): Effect.fn.Return<
  { signedIn: boolean; enabled: boolean },
  SubscriptionProbeFailed,
  Secrets | LanguageModel
> {
  const secrets = yield* Secrets;
  const status = yield* getCodexStatus(secrets);
  // Routing is only consulted for a signed-in account, as the `&&` did.
  if (!status.signedIn) return { signedIn: false, enabled: false };
  const enabled = yield* isCodexSubscriptionActive(CHATGPT_SETUP_MODEL).pipe(
    Effect.mapError(
      (cause) =>
        new SubscriptionProbeFailed({
          member: 'isCodexSubscriptionActive',
          message: 'ChatGPT subscription routing could not be resolved.',
          cause,
        }),
    ),
  );
  return { signedIn: true, enabled };
});
