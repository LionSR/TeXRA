// Builds the "Resume this session with: …" hint printed to scrollback on exit.
//
// Lists the main session plus each resumable tool-use subagent so any route
// can be continued by its own id. Workflows are excluded — they don't resume
// (only tool-use agents do). Reads only the in-memory stream tree, which still
// holds finished subagents for the session, so no exit-time disk I/O is needed.

import { quote } from 'shell-quote';

import type { CliApprovalPolicy } from '@cli/schemas/cliSettings';
import {
  AgentCategory,
  sumUsageStats,
  type StreamTabId,
  type TokenUsageStats,
} from '@shared/schemas';

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

export type ResumeUsageStats = TokenUsageStats & {
  readonly reasoningTokens?: number;
};

export interface ResumeCommandOptions {
  /** Effective workspace for the session being resumed. */
  readonly cwd?: string;
  /** Ambient shell cwd where the printed command will be copy-pasted. */
  readonly processCwd?: string;
  readonly approvalPolicy?: CliApprovalPolicy;
}

const DEFAULT_RESUME_COMMAND_NAME = 'texra';

export function formatResumeCommand(
  commandName: string | undefined,
  executionId: string,
  options: ResumeCommandOptions = {},
): string {
  const cwd = options.cwd?.trim();
  const cwdArg =
    cwd && cwd !== options.processCwd?.trim() ? ` --cwd ${quote([cwd])}` : '';
  const policyFlag =
    options.approvalPolicy && options.approvalPolicy !== 'ask'
      ? ` --approval-policy ${options.approvalPolicy}`
      : '';
  return `${commandName || DEFAULT_RESUME_COMMAND_NAME} resume ${executionId}${cwdArg}${policyFlag}`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function usageHasTokens(usage: ResumeUsageStats): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    (usage.cacheReadInputTokens ?? 0) > 0 ||
    (usage.cacheMissInputTokens ?? 0) > 0 ||
    (usage.cacheCreationInputTokens ?? 0) > 0 ||
    (usage.reasoningTokens ?? 0) > 0
  );
}

export function sumResumeUsageStats(
  items: Iterable<ResumeUsageStats>,
): ResumeUsageStats {
  const usages = [...items];
  const total = sumUsageStats(usages);
  const reasoningTokens = usages.reduce(
    (sum, usage) => sum + (usage.reasoningTokens ?? 0),
    0,
  );
  return reasoningTokens > 0 ? { ...total, reasoningTokens } : total;
}

export function collectResumeUsage(
  streams: ReadonlyMap<StreamTabId, StreamSlice>,
): ResumeUsageStats | undefined {
  const usages: ResumeUsageStats[] = [];

  for (const slice of streams.values()) {
    const usage: ResumeUsageStats | undefined =
      slice.cumulativeUsage ?? slice.usage;
    if (!usage || !usageHasTokens(usage)) continue;
    usages.push(usage);
  }

  const total = sumResumeUsageStats(usages);
  return usageHasTokens(total) ? total : undefined;
}

export function formatResumeUsage(
  usage: ResumeUsageStats | undefined,
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
  return `Token usage: ${lines.join(' ')}`;
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
      if (childSlice?.category !== AgentCategory.ToolUse) continue;
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
  usage?: ResumeUsageStats,
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
