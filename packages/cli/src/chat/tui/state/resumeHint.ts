import { Result } from 'effect';
import * as CommandLine from 'effect/process/CommandLine';

import {
  formatCount,
  isEmptyUsage,
  type RunId,
  type TokenUsageStats,
} from '@texra-ai/worldline/schemas';
import { IS_WINDOWS } from '@texra-ai/worldline/node';
import type { CliOutputFormat } from '@texra/shared/cliOutputFormat';
import { usageCostLabel } from '@ui/copy/modelAccess';
import { TASK_ACTIONS } from '@ui/copy/nestedRuns';
import { visibleTokenStats } from '@ui/copy/tokenUsage';

import { runViewOf } from './sessionView';
import type {
  ApprovalPolicy,
  RunView,
  SessionView,
} from '@texra-ai/worldline/schemas';

interface ResumeCommandOptions {
  readonly cwd?: string;
  readonly processCwd?: string;
  readonly approvalPolicy?: ApprovalPolicy;
  readonly outputFormat?: CliOutputFormat;
  readonly print?: boolean;
  readonly skillSourcePaths?: readonly string[];
}

const DEFAULT_RESUME_COMMAND_NAME = 'texra';
/** The shell a person pastes the hint into: PowerShell on Windows. */
const SHELL_FORMAT = IS_WINDOWS ? 'powershell' : 'posix';

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
  const sourceFlags = (options.skillSourcePaths ?? [])
    .map((source) => ` --source ${shellArgument(source)}`)
    .join('');
  return `${commandName || DEFAULT_RESUME_COMMAND_NAME} resume ${runId}${cwdArg}${policyFlag}${outputFormatFlag}${printFlag}${sourceFlags}`;
}

/** Why `run`, when it was launched to run once (a headless `texra run`)
 *  and has ended, is not reopened as a chat: it reads no messages, so a
 *  fork, a new task holding its conversation, is how it continues. One
 *  stopped mid-turn (no outcome yet) still resumes to finish it, and any
 *  other run resumes: both read undefined. */
export function oneShotResumeNotice(
  commandName: string | undefined,
  runId: RunId,
  run: Pick<RunView, 'takesFollowUps' | 'outcome'> | undefined,
): string | undefined {
  if (run?.takesFollowUps !== false || run.outcome === null) return undefined;
  const name = commandName || DEFAULT_RESUME_COMMAND_NAME;
  return `Task ${runId} is a one-shot task and cannot accept follow-up messages. View it with \`${name} history show ${runId}\`, or fork it with \`${name} resume ${runId} --fork\`.`;
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
  // The counters the progress view's usage strip shows, exact.
  const tokens = visibleTokenStats(usage)
    .map(({ label, value }) => `${formatCount(value)} ${label.toLowerCase()}`)
    .join(', ');
  // A task that never reached a model has no cost to state.
  const costLine =
    usage.cost > 0 || usage.usageRoute !== undefined
      ? usageCostLabel(usage)
      : undefined;
  return costLine
    ? `Token usage: ${tokens}\nTask cost: ${costLine}`
    : `Token usage: ${tokens}`;
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
