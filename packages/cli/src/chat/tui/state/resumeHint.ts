import { quote } from 'shell-quote';

import type { CliOutputFormat } from '@cli/schemas/cliSettings';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import {
  isEmptyUsage,
  sumUsageStats,
  type StreamTabId,
  type TokenUsageStats,
} from '@shared/schemas';
import { usageCostLabel } from '@shared/copy/modelAccess';
import type { SessionView } from '@shared/session/sessionView';

import {
  cumulativeUsageOf,
  descendantStreamIds,
  streamViewOf,
} from './sessionView';

export interface ResumeTarget {
  readonly executionId: string;
  readonly label: string;
  readonly isRoot: boolean;
}

interface ResumeTargetsInput {
  readonly view: SessionView;
  readonly rootStreamId: StreamTabId | undefined;
  readonly rootExecutionId: string | undefined;
}

export interface ResumeCommandOptions {
  readonly cwd?: string;
  readonly processCwd?: string;
  readonly approvalPolicy?: TexraApprovalPolicy;
  readonly outputFormat?: CliOutputFormat;
  readonly print?: boolean;
  readonly includeInteropSkills?: boolean;
  readonly skillSourcePaths?: readonly string[];
}

const DEFAULT_RESUME_COMMAND_NAME = 'texra';

export function formatResumeCommand(
  commandName: string | undefined,
  executionId: string,
  options: ResumeCommandOptions = {},
): string {
  const cwd = options.cwd;
  const cwdArg =
    cwd && cwd !== options.processCwd ? ` --cwd ${quote([cwd])}` : '';
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
    .map((source) => ` --source ${quote([source])}`)
    .join('');
  return `${commandName || DEFAULT_RESUME_COMMAND_NAME} resume ${executionId}${cwdArg}${policyFlag}${outputFormatFlag}${printFlag}${interopFlag}${sourceFlags}`;
}

/** The session's metered usage: the root run and every descendant. */
export function collectResumeUsage(
  view: SessionView,
  rootStreamId: StreamTabId | undefined,
): TokenUsageStats | undefined {
  const usages: TokenUsageStats[] = [];
  for (const streamId of descendantStreamIds(view, rootStreamId)) {
    const usage = cumulativeUsageOf(streamViewOf(view, streamId));
    if (usage) usages.push(usage);
  }
  const total = sumUsageStats(usages);
  return isEmptyUsage(total) ? undefined : total;
}

function formatResumeUsage(
  usage: TokenUsageStats | undefined,
): string | undefined {
  if (!usage || isEmptyUsage(usage)) return undefined;
  const total = usage.inputTokens + usage.outputTokens;
  const cached = usage.cacheReadInputTokens ?? 0;
  const reasoning = usage.reasoningTokens ?? 0;
  const lines = [
    `total=${total.toLocaleString('en-US')}`,
    `input=${usage.inputTokens.toLocaleString('en-US')}`,
  ];
  if (cached > 0) lines.push(`(+ ${cached.toLocaleString('en-US')} cached)`);
  lines.push(`output=${usage.outputTokens.toLocaleString('en-US')}`);
  if (reasoning > 0)
    lines.push(`(reasoning ${reasoning.toLocaleString('en-US')})`);
  const costLine = usageCostLabel(usage.cost, usage.usageRoute);
  return costLine
    ? `Token usage: ${lines.join(' ')}\nSession cost: ${costLine}`
    : `Token usage: ${lines.join(' ')}`;
}

export function collectResumeTargets({
  view,
  rootStreamId,
  rootExecutionId,
}: ResumeTargetsInput): readonly ResumeTarget[] {
  const targets: ResumeTarget[] = [];
  const seen = new Set<string>();
  if (rootExecutionId) {
    targets.push({ executionId: rootExecutionId, label: 'main', isRoot: true });
    seen.add(rootExecutionId);
  }
  for (const streamId of descendantStreamIds(view, rootStreamId)) {
    if (streamId === rootStreamId) continue;
    const stream = streamViewOf(view, streamId);
    if (!stream || seen.has(stream.executionId)) continue;
    if (!stream.resumeEligible) continue;
    seen.add(stream.executionId);
    targets.push({
      executionId: stream.executionId,
      label: stream.label,
      isRoot: false,
    });
  }
  return targets;
}

export function formatResumeHint(
  targets: readonly ResumeTarget[],
  usage?: TokenUsageStats,
  commandName?: string,
  commandOptions?: ResumeCommandOptions,
): string | undefined {
  if (targets.length === 0) return undefined;
  const lines = [formatResumeUsage(usage), 'Resume this session with:'].filter(
    (line): line is string => Boolean(line),
  );
  for (const target of targets) {
    lines.push(
      `  ${formatResumeCommand(
        commandName,
        target.executionId,
        commandOptions,
      )}  (${target.label})`,
    );
  }
  return lines.join('\n');
}
