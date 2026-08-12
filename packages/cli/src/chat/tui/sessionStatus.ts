import {
  formatCliModelAccessRoute,
  type CliModelAccessRoute,
} from '@cli/runtime/modelAccessRoute';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import type { StreamSubstate } from '@shared/schemas';
import { summarizeFollowupMessage } from '@shared/subagentFollowup';
import { BACKGROUND_TASK } from '@shared/copy/nestedRuns';
import { formatStreamStatusLabel } from '@shared/streams/streamStatusDisplay';
import { truncateSummary } from '@utils/text/stringUtils';

import { formatResumeCommand } from './state/resumeHint';
import type { BypassState } from './state/cliState';

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
  readonly modelAccess: CliModelAccessRoute;
  readonly approval: string;
  readonly approvalBypasses?: Partial<BypassState>;
  readonly status: string;
  readonly substate?: StreamSubstate;
  readonly activeChildSessions?: number;
  readonly goal?: CliSessionGoalStatus | null;
  readonly queuedFollowUpMessages: readonly string[];
  /** Root execution id, when a run has started. Surfaces the resume command
   *  mid-session instead of only in the exit hint. */
  readonly sessionId?: string;
  readonly commandName?: string;
  readonly cwd?: string;
  readonly processCwd?: string;
  readonly approvalPolicy?: TexraApprovalPolicy;
}

export function formatCliStatusLabel(
  status: string | undefined,
  substate?: StreamSubstate,
  isChildStream?: boolean,
): string {
  // `formatStreamStatusLabel`'s 'cli' style covers the child-stream
  // vocabulary end to end, including WAITING -> "idle" — no separate probe is
  // needed here. A blank status renders as '' for a child row (no status
  // column yet) and as '—' for the root session (an established placeholder
  // slot).
  return formatStreamStatusLabel(status, {
    style: 'cli',
    missingLabel: isChildStream ? '' : '—',
    ...(substate ? { substate } : {}),
  });
}

function queuedFollowUpStatusLines(messages: readonly string[]): string[] {
  if (messages.length === 0) return ['queued follow-ups: 0'];

  return [
    `queued follow-ups: ${messages.length}`,
    ...messages.map(
      (message, index) =>
        `${index + 1}. ${truncateSummary(
          summarizeFollowupMessage(message),
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
  if (bypasses.superYolo) labels.push('delegated tasks');
  if (bypasses.bash) labels.push('commands');
  if (bypasses.toolEdit) labels.push('file edits');
  return labels;
}

export function formatCliSessionStatus(input: CliSessionStatusInput): string {
  const bypassLabels = activeApprovalBypassLabels(input.approvalBypasses);
  return [
    ...(input.teamName ? [`team: ${input.teamName}`] : []),
    `agent: ${input.agent}`,
    `model: ${input.model}`,
    `model access: ${formatCliModelAccessRoute(input.modelAccess)}`,
    `approval: ${input.approval}`,
    ...(bypassLabels.length > 0
      ? [`auto-approvals: ${bypassLabels.join(', ')}`]
      : []),
    `status: ${formatCliStatusLabel(input.status, input.substate)}`,
    ...(input.activeChildSessions && input.activeChildSessions > 0
      ? [`active ${BACKGROUND_TASK.inlinePlural}: ${input.activeChildSessions}`]
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
          `session: ${input.sessionId}`,
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
