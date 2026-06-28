import { type CliContext } from '@cli/runtime/cliContext';
import type { CliApprovalPolicy } from '@cli/schemas/cliSettings';
import { type TuiSession } from '@cli/chat/tui/state/sessionRunState';
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
  readonly switchModel: (model: string) => Promise<void>;
  readonly requestCompaction: () => void;
  readonly resetSession: () => void;
  readonly resumeExecution: (id: ExecutionId) => Promise<void>;
}

/** Open a command's registered inline form, falling back to the generic form. */
export function openCanonicalSlashForm(
  commandName: string,
  registered: SlashCommand | undefined,
  remainder: string,
): void {
  if (registered && openRegisteredCliSlashForm(registered, remainder)) return;
  openCliSlashCommandForm(commandName, remainder);
}
