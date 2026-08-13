// Builds the "Resume this session with: …" hint printed to scrollback on exit.
//
// Lists the main session plus each resumable tool-use subagent so any route
// can be continued by its own id. Workflows are excluded — they don't resume
// (only tool-use agents do). Reads only the in-memory stream tree, which still
// holds finished subagents for the session, so no exit-time disk I/O is needed.

import { quote } from 'shell-quote';

import type { CliOutputFormat } from '@cli/schemas/cliSettings';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import {
  AgentCategory,
  sumUsageStats,
  type StreamTabId,
  type TokenUsageStats,
} from '@shared/schemas';
import { usageRouteBadge } from '@shared/copy/modelAccess';

import { formatCostUsd } from '@utils/text/stringUtils';

import {
  childExecutionLabel,
  retainedChildStreamsFor,
  type ChildStreamEntries,
} from './childExecutions';
import type { StreamSlice } from './cliState';

export interface ResumeTarget {
  readonly executionId: string;
  /** Human label for the route (agent name for subagents, "main" for root). */
  readonly label: string;
  readonly isRoot: boolean;
}

export interface ResumeTargetsInput {
  readonly childStreamEntries: ChildStreamEntries;
  readonly rootExecutionId: string | undefined;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}

export interface ResumeCommandOptions {
  /** Effective workspace for the session being resumed. */
  readonly cwd?: string;
  /** Ambient shell cwd where the printed command will be copy-pasted. */
  readonly processCwd?: string;
  readonly approvalPolicy?: TexraApprovalPolicy;
  readonly outputFormat?: CliOutputFormat;
  /** Preserve an effective non-interactive launch when pasted into a TTY. */
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

function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function usageHasTokens(usage: TokenUsageStats): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    (usage.cacheReadInputTokens ?? 0) > 0 ||
    (usage.cacheMissInputTokens ?? 0) > 0 ||
    (usage.cacheCreationInputTokens ?? 0) > 0 ||
    (usage.reasoningTokens ?? 0) > 0
  );
}

/** Session-level cost line — reuses the shared usage-route badge so the
 *  CLI and extension attribute payment the same way. Empty when there is no
 *  cost to report and no known route to attribute. */
function formatSessionCost(usage: TokenUsageStats): string | undefined {
  const badge = usageRouteBadge(usage.usageRoute);
  if (badge) {
    if (badge.subscription && usage.cost === 0) {
      return `free via ${badge.label}`;
    }
    return `${formatCostUsd(usage.cost)} via ${badge.label}`;
  }
  return usage.cost > 0 ? formatCostUsd(usage.cost) : undefined;
}

export function collectResumeUsage(
  streams: ReadonlyMap<StreamTabId, StreamSlice>,
): TokenUsageStats | undefined {
  const usages: TokenUsageStats[] = [];

  for (const slice of streams.values()) {
    const usage: TokenUsageStats | undefined =
      slice.cumulativeUsage ?? slice.usage;
    if (!usage || !usageHasTokens(usage)) continue;
    usages.push(usage);
  }

  const total = sumUsageStats(usages);
  return usageHasTokens(total) ? total : undefined;
}

export function formatResumeUsage(
  usage: TokenUsageStats | undefined,
): string | undefined {
  if (!usage || !usageHasTokens(usage)) return undefined;
  const total = usage.inputTokens + usage.outputTokens;
  const cached = usage.cacheReadInputTokens ?? 0;
  const reasoning = usage.reasoningTokens ?? 0;
  const lines = [
    `total=${formatInteger(total)}`,
    `input=${formatInteger(usage.inputTokens)}`,
  ];
  if (cached > 0) lines.push(`(+ ${formatInteger(cached)} cached)`);
  lines.push(`output=${formatInteger(usage.outputTokens)}`);
  if (reasoning > 0) lines.push(`(reasoning ${formatInteger(reasoning)})`);
  const costLine = formatSessionCost(usage);
  return costLine
    ? `Token usage: ${lines.join(' ')}\nSession cost: ${costLine}`
    : `Token usage: ${lines.join(' ')}`;
}

/** The main session followed by each tool-use subagent (any depth), deduped by
 *  executionId. Subagents whose stream isn't a tool-use agent — workflow
 *  children, tool processes — are skipped because they can't be resumed. */
export function collectResumeTargets({
  childStreamEntries,
  rootExecutionId,
  streams,
}: ResumeTargetsInput): readonly ResumeTarget[] {
  const targets: ResumeTarget[] = [];
  const seen = new Set<string>();

  if (rootExecutionId) {
    targets.push({ executionId: rootExecutionId, label: 'main', isRoot: true });
    seen.add(rootExecutionId);
  }

  for (const streamId of streams.keys()) {
    for (const child of retainedChildStreamsFor(
      streamId,
      childStreamEntries,
      streams,
    )) {
      if (seen.has(child.executionId)) continue;
      const childSlice = streams.get(child.childStreamId);
      // Resume is a native-agent affordance: an external-CLI session or a
      // process/workflow-script stream is not resumable here.
      const identity = childSlice?.identity;
      if (
        identity?.kind !== 'agent' ||
        identity.tool !== undefined ||
        childSlice?.category !== AgentCategory.ToolUse
      ) {
        continue;
      }
      seen.add(child.executionId);
      targets.push({
        executionId: child.executionId,
        label: childExecutionLabel(child),
        isRoot: false,
      });
    }
  }

  return targets;
}

/** Multi-line reopen hint, or undefined when there's nothing to resume. */
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
