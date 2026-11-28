// The command that resumes a stored task, as a person pastes it into a
// shell. Every surface that names it reads it here: the chat's exit hint and
// status bar, the headless interruption hint and `texra resume`.
import { Result } from 'effect';
import * as CommandLine from 'effect/process/CommandLine';

import {
  APPROVAL_POLICY_DEFAULT,
  type ApprovalPolicy,
  type RunId,
  type RunView,
} from '@texra-ai/worldline/schemas';
import { IS_WINDOWS } from '@texra-ai/worldline/node';
import type { CliOutputFormat } from '@texra/shared/cliOutputFormat';

export interface ResumeCommandOptions {
  readonly cwd?: string;
  readonly processCwd?: string;
  readonly approvalPolicy?: ApprovalPolicy;
  readonly outputFormat?: CliOutputFormat;
  readonly print?: boolean;
  readonly skillSourcePaths?: readonly string[];
}

/** The shell a person pastes the hint into: PowerShell on Windows. */
const SHELL_FORMAT = IS_WINDOWS ? 'powershell' : 'posix';

/** A path from argv or the working directory, which holds no NUL to fail on. */
const shellArgument = (value: string): string =>
  Result.getOrThrow(CommandLine.quote(value, { format: SHELL_FORMAT }));

export function formatResumeCommand(
  commandName: string,
  runId: string,
  options: ResumeCommandOptions = {},
): string {
  const cwd = options.cwd;
  const cwdArg =
    cwd && cwd !== options.processCwd ? ` --cwd ${shellArgument(cwd)}` : '';
  const policyFlag =
    options.approvalPolicy && options.approvalPolicy !== APPROVAL_POLICY_DEFAULT
      ? ` --approval-policy ${options.approvalPolicy}`
      : '';
  const outputFormatFlag =
    options.outputFormat && options.outputFormat !== 'text'
      ? ` --output-format ${options.outputFormat}`
      : '';
  const printFlag = options.print === true ? ' --print' : '';
  const sourceFlags = (options.skillSourcePaths ?? [])
    .map((source) => ` --source ${shellArgument(source)}`)
    .join('');
  return `${commandName} resume ${runId}${cwdArg}${policyFlag}${outputFormatFlag}${printFlag}${sourceFlags}`;
}

/** Why `run`, when it was launched to run once (a headless `texra run`)
 *  and has ended, is not reopened as a chat: it reads no messages, so a
 *  fork, a new task holding its conversation, is how it continues. One
 *  stopped mid-turn (no outcome yet) still resumes to finish it, and any
 *  other run resumes: both read undefined. */
export function oneShotResumeNotice(
  commandName: string,
  runId: RunId,
  run: Pick<RunView, 'takesFollowUps' | 'outcome'> | undefined,
): string | undefined {
  if (run?.takesFollowUps !== false || run.outcome === null) return undefined;
  return `Task ${runId} is a one-shot task and cannot accept follow-up messages. View it with \`${commandName} history show ${runId}\`, or fork it with \`${commandName} resume ${runId} --fork\`.`;
}
