/**
 * VS Code-free platform adapter for setup tools.
 *
 * Setup tools live in the app's VS Code-free zone. Each reads its
 * credentials from the `Secrets` service directly; hosts provide only the
 * capabilities that actually vary, as the `SetupPlatform` service.
 *
 * Keep this interface narrow — add methods only when a setup tool needs them.
 */

// Third-party imports
import { Context, Effect, Layer, Schema } from 'effect';

// Local imports
import { getCodexStatus } from '@texra-ai/llm/node';
import { readModelOptions, Secrets } from '@texra-ai/harness';
import { ToolError } from '@texra-ai/harness/plugins';
import type {
  TerminalRunFailed,
  TerminalRunRequest,
  TerminalRunResult,
} from '@texra/hosts/uiHosts';
import { CHATGPT_SETUP_MODEL } from '@texra/model/setupModelDefaults';
import type { SettingsStores } from '@texra-ai/harness';

/**
 * A host command that was dispatched and rejected (the VS Code host's own
 * `executeCommand`). A host with no command surface leaves `commands`
 * undefined instead of raising, and the tool reports that absence itself.
 */
export class SetupCommandFailed extends Schema.TaggedError<SetupCommandFailed>()(
  'SetupCommandFailed',
  {
    message: Schema.String,
    commandId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * The one failure of {@link SetupExtensionAdapter.install}: the host refused
 * the install. There is no second reason, because a host without an
 * extension surface leaves `extensions` undefined rather than raising —
 * the caller already reports that absence itself.
 */
export class SetupExtensionInstallFailed extends Schema.TaggedError<SetupExtensionInstallFailed>()(
  'SetupExtensionInstallFailed',
  {
    message: Schema.String,
    extensionId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

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
  /** VS Code-only command invocation. */
  commands?: SetupCommandAdapter;
  /** VS Code extension inspection and installation. */
  extensions?: SetupExtensionAdapter;
  /**
   * VS Code integrated-terminal execution: the surface the setup agent uses
   * for commands the captured-stdio `bash` tool cannot handle (`sudo`
   * password prompts, other interactive TTY prompts, anything the user must
   * type into). An implementation should prefer VS Code's stable
   * `Terminal.shellIntegration` API (since 1.93) so the agent reads back an
   * exit code and output; without it the run may answer an `undefined` exit
   * code and empty output, which the caller treats as "user interrupted".
   *
   * The member is an `Effect`: a host fault reaches the setup tool as
   * {@link TerminalRunFailed} rather than as `unknown`, and interrupting the
   * fiber abandons the wait instead of holding it open.
   */
  terminal?: (
    request: TerminalRunRequest,
  ) => Effect.Effect<TerminalRunResult, TerminalRunFailed>;
}

/**
 * The host's setup capabilities as an Effect service
 * (`@texra/setup/SetupPlatform`), served by the setup plugin's process layer
 * over what the host passes `texraPlugins`; a setup tool reads it with
 * `yield* SetupPlatform`.
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

/**
 * The ChatGPT subscription routing probe could not answer. It reads the
 * routing built from the stored OAuth session; it never reports "no
 * subscription" this way, which is a value. It stays `Promise`-shaped with
 * the rest of the account group.
 */
class SubscriptionProbeFailed extends Schema.TaggedError<SubscriptionProbeFailed>()(
  'SubscriptionProbeFailed',
  {
    member: Schema.Literals(['getCodexStatus', 'readModelOptions']),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Subscription access reported separately from provider API keys. */
export const getChatGptSubscriptionStatus = Effect.fn(
  'getChatGptSubscriptionStatus',
)(function* (
  stores: SettingsStores,
): Effect.fn.Return<
  { signedIn: boolean; enabled: boolean },
  SubscriptionProbeFailed,
  Secrets
> {
  const secrets = yield* Secrets;
  const status = yield* getCodexStatus(secrets).pipe(
    Effect.mapError(
      (cause) =>
        new SubscriptionProbeFailed({
          member: 'getCodexStatus',
          message: 'The ChatGPT subscription session could not be read.',
          cause,
        }),
    ),
  );
  // Routing is only consulted for a signed-in account, as the `&&` did.
  if (!status.signedIn) return { signedIn: false, enabled: false };
  const [option] = yield* readModelOptions({ ...stores, secrets }, [
    CHATGPT_SETUP_MODEL,
  ]).pipe(
    Effect.mapError(
      (cause) =>
        new SubscriptionProbeFailed({
          member: 'readModelOptions',
          message: 'ChatGPT subscription routing could not be resolved.',
          cause,
        }),
    ),
  );
  return {
    signedIn: true,
    enabled: option?.usageRoute === 'chatgpt-subscription',
  };
});
