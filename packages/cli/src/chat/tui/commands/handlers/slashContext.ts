import { type CliContext } from '@cli/runtime/cliContext';
import { type CliNoAvailableModelsRecoveryOptions } from '@cli/runtime/modelAccess';
import { setTransientNotice } from '@cli/chat/tui/state/cliState';
import { type TuiSession } from '@cli/chat/tui/state/sessionRunState';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import { type ExecutionId } from '@shared/schemas';
import { INCLUDED_ACCESS, OWN_API_KEYS } from '@shared/copy/modelAccess';

/** Shared context every slash-command handler receives from the chat TUI. */
export interface SlashCommandContext {
  readonly cliContext: CliContext;
  readonly session: TuiSession;
  readonly commandName?: string;
  readonly cwd: CliContext['cwd'];
  readonly processCwd?: CliContext['cwd'];
  readonly initialAgent: string;
  readonly initialModel: string;
  readonly interruptActive: () => void;
  readonly requestInputExit: () => void;
  readonly getApprovalPolicy: () => TexraApprovalPolicy;
  readonly setApprovalPolicy: (policy: TexraApprovalPolicy) => void;
  readonly canSelectModel: () => boolean;
  readonly resetSession: () => void;
  readonly resumeExecution: (id: ExecutionId) => Promise<void>;
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
  includedModeAction: `switch to ${INCLUDED_ACCESS.inline} with \`/api included\``,
  loginAction: 'run `/login`',
  personalModeAction: `switch to ${OWN_API_KEYS.inline} with \`/api personal\``,
  configureKeyAction: 'add a provider API key',
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
