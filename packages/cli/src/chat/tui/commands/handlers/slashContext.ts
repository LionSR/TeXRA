import { type CliContext } from '@cli/runtime/platform/cliContext';
import { type CliNoAvailableModelsRecoveryOptions } from '@cli/runtime/models/modelAccess';
import { type CliSignInProgress } from '@cli/runtime/models/signInUrl';
import { setTransientNotice } from '@cli/chat/tui/state/cliState';
import { type TuiSession } from '@cli/chat/tui/state/sessionRunState';
import { appendLocalNotice } from '@cli/chat/tui/state/transcript';
import type { RunId, ApprovalPolicy } from '@texra-ai/harness/schemas';
import type { Session } from '@texra-ai/harness';
import type {
  ProcessRuntime,
  ProcessServices,
  SettingsStores,
} from '@texra-ai/harness/host';
import type { Effect } from 'effect';
import type { BuiltinSlashCommands } from '../registerBuiltins';

/**
 * What a slash command does, as a program the dispatcher runs: the chat's
 * Ink handlers fork these on the process runtime, so a handler takes the
 * session's services from context instead of running its own edge, and its
 * failure is the dispatcher's to report.
 */
export type SlashCommandEffect = Effect.Effect<void, Error, ProcessServices>;

/** Shared context every slash-command handler receives from the chat TUI. */
export interface SlashCommandContext {
  /** The chat's slash commands: what the dispatcher looks a line up in. */
  readonly commands: BuiltinSlashCommands;
  readonly cliContext: CliContext;
  readonly session: TuiSession;
  /** Where run requests and resumes land, and the project's stored runs
   *  are read (`/status` a run's offered skills, `/resume` the listing):
   *  the chat's session, here or in the background service. */
  readonly runSession: Session;
  /**
   * The three setting slots the account, model-access and model-selection
   * commands read, filled from the `CliPlatformServices` the chat entry point
   * already holds.
   */
  readonly stores: SettingsStores;
  /**
   * The runtime the chat entry point holds. Model access is read as an Effect,
   * so the handlers that ask for it run that program here rather than looking
   * a runtime up.
   */
  readonly runtime: ProcessRuntime;
  readonly processCwd?: CliContext['cwd'];
  readonly requestInputExit: () => void;
  readonly getApprovalPolicy: () => ApprovalPolicy;
  readonly setApprovalPolicy: (policy: ApprovalPolicy) => Effect.Effect<void>;
  /** Start a new task (`/clear`): false, with a notice, while a response
   *  is running. */
  readonly resetSession: () => boolean;
  readonly resumeRun: (id: RunId) => Effect.Effect<void, Error>;
}

/** Output boundary shared by direct slash dispatch and busy form submission. */
export interface SlashCommandOutput {
  readonly appendOutcome: (message: string) => void;
  readonly setNotice: (message: string) => void;
  readonly writeProgress: CliSignInProgress;
}

/** Direct command output remains in the ordinary TUI transcript. */
export const transcriptSlashCommandOutput: SlashCommandOutput = {
  appendOutcome: appendLocalNotice,
  setNotice: setTransientNotice,
  // Instructions (a sign-in URL, a device code) and guidance (a hint, a failed
  // launch) stay in the transcript; a status line ("Opening browser...") is
  // not a result worth a permanent row.
  writeProgress: (message, options) =>
    options?.copyable || options?.persistent
      ? appendLocalNotice(message)
      : setTransientNotice(message),
};

export const CHAT_API_MODE_MODEL_RECOVERY = {
  configureKeyAction: 'add a provider API key with `/key`',
} satisfies CliNoAvailableModelsRecoveryOptions;
