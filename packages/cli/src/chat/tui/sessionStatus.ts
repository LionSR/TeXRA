import {
  getModelLabel,
  truncateSummary,
  isEmptyUsage,
  runBypasses,
  type TokenUsageStats,
  type UsageRoute,
} from '@texra-ai/worldline/schemas';
import { OWN_API_KEYS, usageRouteBadge } from '@ui/copy/modelAccess';
import { formatApprovalPolicy } from '@ui/copy/approvalPolicy';
import { RUN_GRANT_NOUN, RUN_GRANT_ORDER } from '@ui/copy/delegationApproval';
import { usageCostLabel } from '@ui/copy/modelAccess';
import { OWN_USAGE_LABEL } from '@ui/copy/tokenUsage';
import { runStatus } from '@ui/copy/runStatus';

import { formatResumeCommand } from './state/resumeHint';
import type {
  ApprovalPolicy,
  RunView,
  SessionView,
} from '@texra-ai/worldline/schemas';

const QUEUED_MESSAGE_STATUS_LENGTH = 160;

/** What `/status` prints that the session view does not hold. */
interface CliSessionStatusInput {
  readonly agent: string;
  /** The session's model, shown until a run records its own. */
  readonly model: string;
  /** The route the next request would take; a run's completed request
   *  cannot change route, so its own outranks this one. */
  readonly modelAccess: UsageRoute | undefined;
  /** Skill names in effect for the focused tool-use stream, newest snapshot. */
  readonly activeSkills: readonly string[];
  /** Root run id, when a run has started. Surfaces the resume command
   *  mid-session instead of only in the exit hint. */
  readonly sessionId?: string;
  readonly commandName: string;
  readonly cwd?: string;
  readonly processCwd?: string;
  readonly approvalPolicy: ApprovalPolicy;
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
 * The spend of the task `run` belongs to, read off the session view: its root's
 * `treeUsage`, the root's own calls (`usage`), and each agent the root
 * started that spent anything, with that agent's `treeUsage`. `/status` and
 * the status bar both read it, whichever run they describe.
 */
export function taskCostStatus(
  view: Pick<SessionView, 'runs'>,
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

function costStatusLines(cost: CliSessionCostStatus | undefined): string[] {
  if (cost === undefined) return [];
  if (cost.agents.length === 0) return [`cost: ${usageCostLabel(cost.total)}`];
  return [
    `cost: ${usageCostLabel(cost.total)}, agents included`,
    `  ${OWN_USAGE_LABEL.toLowerCase()}: ${usageCostLabel(cost.own)}`,
    ...cost.agents.map(
      (agent) => `  ${agent.label}: ${usageCostLabel(agent.usage)}`,
    ),
  ];
}

function queuedMessageStatusLines(messages: readonly string[]): string[] {
  if (messages.length === 0) return ['queued messages: 0'];

  return [
    `queued messages: ${messages.length}`,
    ...messages.map(
      (message, index) =>
        `${index + 1}. ${truncateSummary(
          message,
          QUEUED_MESSAGE_STATUS_LENGTH,
        )}`,
    ),
  ];
}

/** The `/status` notice for `run`, the run the chat is focused on; undefined
 *  before one starts. Its status, spend, grants, agents and queued messages
 *  are read off the view. */
export function formatCliSessionStatus(
  view: SessionView,
  run: RunView | undefined,
  input: CliSessionStatusInput,
): string {
  // The grants given with `a` on a card, named as the cards and the
  // extension's header chips name them.
  const bypasses = run && runBypasses(view, run.id);
  const bypassLabels = RUN_GRANT_ORDER.filter(
    (kind) => bypasses?.[kind] === true,
  ).map((kind) => RUN_GRANT_NOUN[kind]);
  const activeAgents = run?.rollup.running ?? 0;
  return [
    `agent: ${input.agent}`,
    `model: ${getModelLabel(run?.model ?? input.model)}`,
    `model access: ${usageRouteBadge(run?.usage.usageRoute ?? input.modelAccess)?.label ?? OWN_API_KEYS.inline}`,
    `approval: ${formatApprovalPolicy(input.approvalPolicy)}`,
    ...(bypassLabels.length > 0
      ? [`auto-approvals: ${bypassLabels.join(', ')}`]
      : []),
    `status: ${run ? runStatus(run).word : 'not started'}`,
    ...costStatusLines(taskCostStatus(view, run)),
    ...(activeAgents > 0 ? [`active agents: ${activeAgents}`] : []),
    ...(input.activeSkills.length > 0
      ? [`skills: ${input.activeSkills.join(', ')}`]
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
    ...queuedMessageStatusLines(
      (run?.queuedFollowUps ?? []).map((followUp) => followUp.text),
    ),
  ].join('\n');
}
