import { Result } from 'effect';
import * as CommandLine from 'effect/process/CommandLine';

import {
  isEmptyUsage,
  type RunId,
  type TokenUsageStats,
} from '@texra-ai/harness/schemas';
import type { CliOutputFormat } from '@texra/shared/cliOutputFormat';
import { usageCostLabel } from '@ui/copy/modelAccess';
import { TASK_ACTIONS } from '@ui/copy/nestedRuns';

import { runViewOf } from './sessionView';
import type { ApprovalPolicy, SessionView } from '@texra-ai/harness/schemas';

interface ResumeCommandOptions {
  readonly cwd?: string;
  readonly processCwd?: string;
  readonly approvalPolicy?: ApprovalPolicy;
  readonly outputFormat?: CliOutputFormat;
  readonly print?: boolean;
  readonly includeInteropSkills?: boolean;
  readonly skillSourcePaths?: readonly string[];
}

const DEFAULT_RESUME_COMMAND_NAME = 'texra';
/** The shell a person pastes the hint into: PowerShell on Windows. */
const SHELL_FORMAT = process.platform === 'win32' ? 'powershell' : 'posix';

/** A path from argv or the working directory, which holds no NUL to fail on. */
const shellArgument = (value: string): string =>
  Result.getOrThrow(CommandLine.quote(value, { format: SHELL_FORMAT }));

export function formatResumeCommand(
  commandName: string | undefined,
  runId: string,
  options: ResumeCommandOptions = {},
): string {
  const cwd = options.cwd;
  const cwdArg =
    cwd && cwd !== options.processCwd ? ` --cwd ${shellArgument(cwd)}` : '';
  const policyFlag =
    options.approvalPolicy && options.approvalPolicy !== 'ask'
      ? ` --approval-policy ${options.approvalPolicy}`
      : '';
  const outputFormatFlag =
    options.outputFormat && options.outputFormat !== 'text'
      ? ` --output-format ${options.outputFormat}`
      : '';
  const printFlag = options.print === true ? ' --print' : '';
  const interopFlag =
    options.includeInteropSkills === true ? ' --include-interop' : '';
  const sourceFlags = (options.skillSourcePaths ?? [])
    .map((source) => ` --source ${shellArgument(source)}`)
    .join('');
  return `${commandName || DEFAULT_RESUME_COMMAND_NAME} resume ${runId}${cwdArg}${policyFlag}${outputFormatFlag}${printFlag}${interopFlag}${sourceFlags}`;
}

/** Why a run launched to run once (a headless `texra run`) that ended is
 *  not reopened as a chat: it reads no messages, so a fork, a new task
 *  holding its conversation, is how it continues. */
export function oneShotResumeNotice(
  commandName: string | undefined,
  runId: RunId,
): string {
  const name = commandName || DEFAULT_RESUME_COMMAND_NAME;
  return `Task ${runId} ran once and takes no messages. See it with \`${name} history show ${runId}\`, or continue it in a new task with \`${name} resume ${runId} --fork\`.`;
}

/** The task's metered usage: the root run and every descendant. */
export function collectResumeUsage(
  view: SessionView,
  rootRunId: RunId | undefined,
): TokenUsageStats | undefined {
  const total = runViewOf(view, rootRunId)?.treeUsage;
  return total === undefined || isEmptyUsage(total) ? undefined : total;
}

function formatResumeUsage(
  usage: TokenUsageStats | undefined,
): string | undefined {
  if (!usage || isEmptyUsage(usage)) return undefined;
  const total = usage.inputTokens + usage.outputTokens;
  const cached = usage.cachedInputTokens ?? 0;
  const reasoning = usage.reasoningTokens ?? 0;
  const lines = [
    `total=${total.toLocaleString('en-US')}`,
    `input=${usage.inputTokens.toLocaleString('en-US')}`,
  ];
  if (cached > 0) lines.push(`(+ ${cached.toLocaleString('en-US')} cached)`);
  lines.push(`output=${usage.outputTokens.toLocaleString('en-US')}`);
  if (reasoning > 0)
    lines.push(`(reasoning ${reasoning.toLocaleString('en-US')})`);
  // A task that never reached a model has no cost to state.
  const costLine =
    usage.cost > 0 || usage.usageRoute !== undefined
      ? usageCostLabel(usage)
      : undefined;
  return costLine
    ? `Token usage: ${lines.join(' ')}\nTask cost: ${costLine}`
    : `Token usage: ${lines.join(' ')}`;
}

/** The exit hint: the task's usage, then the one command that resumes its
 *  root run (a child resumes through its parent). */
export function formatResumeHint(
  runId: RunId,
  usage?: TokenUsageStats,
  commandName?: string,
  commandOptions?: ResumeCommandOptions,
): string {
  return [
    formatResumeUsage(usage),
    TASK_ACTIONS.resumeHint,
    `  ${formatResumeCommand(commandName, runId, commandOptions)}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}
