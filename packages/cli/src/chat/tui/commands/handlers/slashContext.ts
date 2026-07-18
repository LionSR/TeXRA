import { type CliContext } from '@cli/runtime/cliContext';
import { type CliNoAvailableModelsRecoveryOptions } from '@cli/runtime/modelAccess';
import type { CliApprovalPolicy } from '@cli/schemas/cliSettings';
import { setTransientNotice } from '@cli/chat/tui/state/cliState';
import { type TuiSession } from '@cli/chat/tui/state/sessionRunState';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import { type ExecutionId } from '@shared/schemas';

import {
  openCliSlashCommandForm,
  openRegisteredCliSlashForm,
} from '../slashForms';
import { type SlashCommand } from '../slashRegistry';

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
  readonly getApprovalPolicy: () => CliApprovalPolicy;
  readonly setApprovalPolicy: (policy: CliApprovalPolicy) => void;
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
  includedModeAction: 'switch to included TeXRA access with `/api included`',
  loginAction: 'run `/login`',
  personalModeAction: 'switch to personal API keys with `/api personal`',
  configureKeyAction: 'configure a provider API key',
} satisfies CliNoAvailableModelsRecoveryOptions;

/** Open a command's registered inline form, falling back to the generic form. */
export function openCanonicalSlashForm(
  commandName: string,
  registered: SlashCommand | undefined,
  remainder: string,
  onPersist?: () => void,
): void {
  if (
    registered &&
    openRegisteredCliSlashForm(registered, remainder, onPersist)
  )
    return;
  openCliSlashCommandForm(commandName, remainder, onPersist);
}
