import { formatCliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import {
  isEmptyUsage,
  type TokenUsageStats,
  type UsageRoute,
} from '@shared/schemas';
import type { RunView, SessionView } from '@shared/session/sessionView';
import {
  formatTexraApprovalPolicy,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import { summarizeSubagentFollowup } from '@shared/subagentFollowup';
import { getModelLabel } from '@shared/model/modelLabel';
import { usageCostLabel } from '@ui/copy/modelAccess';
import { formatCostUsd, truncateSummary } from '@utils/text/stringUtils';

import { formatResumeCommand } from './state/resumeHint';
import type { BypassState } from './panes/statusBarDisplay';

const QUEUED_FOLLOW_UP_STATUS_LENGTH = 160;
const GOAL_OBJECTIVE_STATUS_LENGTH = 160;

interface CliSessionGoalStatus {
  readonly status: string;
  readonly objective: string;
}

export interface CliSessionStatusInput {
  readonly agent: string;
  readonly model: string;
  readonly teamName?: string;
  readonly modelAccess: UsageRoute | undefined;
  readonly approvalBypasses?: Partial<BypassState>;
  /** The fold's status label for the reported stream; undefined before a run. */
  readonly statusLabel: string | undefined;
  readonly activeChildSessions?: number;
  readonly goal?: CliSessionGoalStatus | null;
  /** Skill names in effect for the focused tool-use stream, newest snapshot. */
  readonly activeSkills: readonly string[];
  readonly queuedFollowUpMessages: readonly string[];
  /** Root run id, when a run has started. Surfaces the resume command
   *  mid-session instead of only in the exit hint. */
  readonly sessionId?: string;
  readonly commandName?: string;
  readonly cwd?: string;
  readonly processCwd?: string;
  readonly approvalPolicy: TexraApprovalPolicy;
  /** The task's spend (`taskCostStatus`); undefined before anything is
   *  metered. */
  readonly cost?: CliSessionCostStatus;
}

interface CliSessionCostStatus {
  readonly total: TokenUsageStats;
  readonly own: TokenUsageStats;
  readonly agents: readonly {
    readonly label: string;
    readonly usage: TokenUsageStats;
  }[];
}

/**
 * The spend of the task `run` belongs to, read off the fold: its root's
 * `treeUsage`, the root's own calls (`usage`), and each agent the root
 * started that spent anything, with that agent's `treeUsage`.
 */
export function taskCostStatus(
  view: SessionView,
  run: RunView | undefined,
): CliSessionCostStatus | undefined {
  if (run === undefined) return undefined;
  const root = view.runs.get(run.ancestors[0]?.id ?? run.id);
  if (root === undefined || isEmptyUsage(root.treeUsage)) return undefined;
  return {
    total: root.treeUsage,
    own: root.usage,
    agents: root.childIds.flatMap((childId) => {
      const child = view.runs.get(childId);
      return child === undefined || isEmptyUsage(child.treeUsage)
        ? []
        : [{ label: child.label, usage: child.treeUsage }];
    }),
  };
}

function costLabel(usage: TokenUsageStats): string {
  return (
    usageCostLabel(usage.cost, usage.usageRoute, usage.usagePlan) ??
    formatCostUsd(usage.cost)
  );
}

function costStatusLines(cost: CliSessionCostStatus | undefined): string[] {
  if (cost === undefined) return [];
  if (cost.agents.length === 0) return [`cost: ${costLabel(cost.total)}`];
  return [
    `cost: ${costLabel(cost.total)}, agents included`,
    `  own model calls: ${costLabel(cost.own)}`,
    ...cost.agents.map(
      (agent) => `  ${agent.label}: ${costLabel(agent.usage)}`,
    ),
  ];
}

function queuedFollowUpStatusLines(messages: readonly string[]): string[] {
  if (messages.length === 0) return ['queued follow-ups: 0'];

  return [
    `queued follow-ups: ${messages.length}`,
    ...messages.map(
      (message, index) =>
        `${index + 1}. ${truncateSummary(
          summarizeSubagentFollowup(message),
          QUEUED_FOLLOW_UP_STATUS_LENGTH,
        )}`,
    ),
  ];
}

function activeApprovalBypassLabels(
  bypasses: Partial<BypassState> | undefined,
): string[] {
  if (!bypasses) return [];
  const labels: string[] = [];
  if (bypasses.superYolo) labels.push('agent work');
  if (bypasses.bash) labels.push('commands');
  if (bypasses.toolEdit) labels.push('file edits');
  return labels;
}

export function formatCliSessionStatus(input: CliSessionStatusInput): string {
  const bypassLabels = activeApprovalBypassLabels(input.approvalBypasses);
  return [
    ...(input.teamName ? [`team: ${input.teamName}`] : []),
    `agent: ${input.agent}`,
    `model: ${getModelLabel(input.model)}`,
    `model access: ${formatCliModelAccessRoute(input.modelAccess)}`,
    `approval: ${formatTexraApprovalPolicy(input.approvalPolicy)}`,
    ...(bypassLabels.length > 0
      ? [`auto-approvals: ${bypassLabels.join(', ')}`]
      : []),
    `status: ${input.statusLabel ?? 'not started'}`,
    ...costStatusLines(input.cost),
    ...((input.activeChildSessions ?? 0) > 0
      ? [`active agents: ${input.activeChildSessions}`]
      : []),
    ...(input.activeSkills.length > 0
      ? [`skills: ${input.activeSkills.join(', ')}`]
      : []),
    ...(input.goal
      ? [
          `goal: ${input.goal.status}`,
          `goal objective: ${truncateSummary(
            input.goal.objective,
            GOAL_OBJECTIVE_STATUS_LENGTH,
          )}`,
        ]
      : []),
    ...(input.sessionId
      ? [
          `task: ${input.sessionId}`,
          `resume later with: ${formatResumeCommand(
            input.commandName,
            input.sessionId,
            {
              cwd: input.cwd,
              processCwd: input.processCwd,
              approvalPolicy: input.approvalPolicy,
            },
          )}`,
        ]
      : []),
    ...queuedFollowUpStatusLines(input.queuedFollowUpMessages),
  ].join('\n');
}
