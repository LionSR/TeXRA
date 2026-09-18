import { type SessionHandle } from '@agent/runtime';
import { type CliContext } from '@cli/runtime/cliContext';
import { type CliNoAvailableModelsRecoveryOptions } from '@cli/runtime/modelAccess';
import { setTransientNotice } from '@cli/chat/tui/state/cliState';
import { type TuiSession } from '@cli/chat/tui/state/sessionRunState';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import { type RunId } from '@shared/schemas';

/** Shared context every slash-command handler receives from the chat TUI. */
export interface SlashCommandContext {
  readonly cliContext: CliContext;
  readonly session: TuiSession;
  /** The chat's runtime session: the session commands read run state and land
   *  requests on it, threaded from the chat entry point that opened it. */
  readonly runtimeSession: SessionHandle;
  /**
   * The process secret store and the three setting slots the account,
   * model-access and model-selection commands read, filled from the
   * `CliPlatformServices` the chat entry point already holds.
   */
  readonly secrets: PlatformSecrets;
  readonly stores: SettingsStores;
  /**
   * The runtime the chat entry point holds. Model access is read as an Effect,
   * so the handlers that ask for it run that program here rather than looking
   * a runtime up.
   */
  readonly runtime: ProcessRuntime;
  readonly processCwd?: CliContext['cwd'];
  readonly initialAgent: string;
  readonly initialModel: string;
  readonly requestInputExit: () => void;
  readonly getApprovalPolicy: () => TexraApprovalPolicy;
  readonly setApprovalPolicy: (policy: TexraApprovalPolicy) => void;
  readonly canSelectModel: () => boolean;
  readonly resetSession: () => void;
  readonly resumeRun: (id: RunId) => Promise<void>;
}

/** Output boundary shared by direct slash dispatch and busy form submission. */
export interface SlashCommandOutput {
  readonly appendOutcome: (message: string) => void;
  readonly setNotice: (message: string) => void;
  readonly writeProgress: (
    message: string,
    options?: { readonly copyable?: boolean },
  ) => void;
}

/** Direct command output remains in the ordinary TUI transcript. */
export const transcriptSlashCommandOutput: SlashCommandOutput = {
  appendOutcome: appendLocalAssistantTranscript,
  setNotice: setTransientNotice,
  writeProgress: (message) => appendLocalAssistantTranscript(message),
};

export const CHAT_API_MODE_MODEL_RECOVERY = {
  configureKeyAction: 'add a provider API key with `/key`',
} satisfies CliNoAvailableModelsRecoveryOptions;

/** Start an abortable slash-command action and expose `abort` on its promise. */
export function abortableSlashCommand(
  run: (signal: AbortSignal) => Promise<void>,
): Promise<void> & { readonly abort: () => void } {
  const controller = new AbortController();
  return Object.assign(run(controller.signal), {
    abort: () => controller.abort(),
  });
}
