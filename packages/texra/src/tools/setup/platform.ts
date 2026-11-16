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
import { Context, Effect, Schema } from 'effect';

// Local imports
import type {
  TerminalRunFailed,
  TerminalRunRequest,
  TerminalRunResult,
} from '@texra/hosts/uiHosts';

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

/** Host-varying setup capabilities. */
export interface SetupPlatformShape {
  /** VS Code-only command invocation. */
  commands?: SetupCommandAdapter;
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
 * (`'@texra-ai/texra/tools/SetupPlatform'`), served by the setup plugin's process layer
 * over what the host passes `texraPlugins`; a setup tool reads it with
 * `yield* SetupPlatform`.
 */
export class SetupPlatform extends Context.Service<
  SetupPlatform,
  SetupPlatformShape
>()('@texra-ai/texra/tools/SetupPlatform') {}

/** Which host the setup agent runs in, as the host names itself to
 *  `texraPlugins`; the environment probe reports it. */
export class SetupHost extends Context.Service<
  SetupHost,
  'vscode' | 'desktop' | 'cli'
>()('@texra-ai/texra/tools/SetupHost') {}
