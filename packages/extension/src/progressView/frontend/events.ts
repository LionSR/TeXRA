/**
 * The decision vocabulary of the request panels: what each permission kind
 * may answer with. `BaseRequestPanel.emitAction` maps a decision onto the
 * `runtime.request` (or `host.request`) arm it names.
 */

import type { PermissionPayload, UserQuestionAnswers } from '@shared/schemas';

/**
 * Frontend-only panel action emitted by the inline edit/command approval
 * button / `a` shortcut on the edit and bash approval prompts.
 * `handlePermissionAction` decomposes it into a normal approve plus a
 * session-bypass enable, so — unlike `approve` / `reject` / `openDiff` — it
 * never reaches the backend approval protocol. Single source of truth shared
 * by the panel that emits it and the handler that consumes it.
 */
export const APPROVE_SESSION_ACTION = 'approveSession';

/**
 * Frontend-only panel action emitted by the approve-all-delegated-work item on
 * the agent-proposal Approve menu. Like {@link APPROVE_SESSION_ACTION},
 * `handlePermissionAction` decomposes it — into a normal proposal approve plus a
 * per-stream delegated-work bypass enable (`ENABLE_SUPER_YOLO_BYPASS`) — so it
 * never reaches the backend proposal protocol (whose action enum stays
 * `approve | reject | setup`). Single source of truth shared by the panel that
 * emits it and the handler that consumes it.
 */
export const APPROVE_ALL_DELEGATED_WORK_ACTION = 'approveSuperYolo';

interface PermissionPayloadFields {
  feedback: string;
  model: string;
  agent: string;
  answer: string;
  sessionLinks: string[];
  answers: UserQuestionAnswers;
}

type Decision<
  A extends string,
  Payload extends Partial<PermissionPayloadFields> = object,
> = { action: A } & Payload & {
    [K in Exclude<keyof PermissionPayloadFields, keyof Payload>]?: never;
  };

type RejectDecision = Decision<'reject', { feedback?: string }>;

interface PermissionDecisionByKind {
  toolEdit:
    | Decision<'approve'>
    | Decision<typeof APPROVE_SESSION_ACTION>
    | RejectDecision
    | Decision<'openDiff' | 'showLatexdiff' | 'previewProposed'>;
  bash:
    | Decision<'approve'>
    | Decision<typeof APPROVE_SESSION_ACTION>
    | RejectDecision;
  retry: Decision<'retry' | 'useOwnApiKey' | 'cancel'>;
  proposal:
    | Decision<
        'approve',
        {
          model?: string;
          agent?: string;
        }
      >
    | Decision<
        typeof APPROVE_ALL_DELEGATED_WORK_ACTION,
        {
          model?: string;
          agent?: string;
        }
      >
    | RejectDecision
    | Decision<'setup'>;
  planApproval:
    Decision<'approve'> | Decision<'approve_and_goal'> | RejectDecision;
  externalInquiry:
    | Decision<
        'submit',
        {
          answer: string;
          sessionLinks?: string[];
        }
      >
    | RejectDecision;
  userQuestion:
    | Decision<'submit', { answers: UserQuestionAnswers }>
    | RejectDecision
    | Decision<'skip', { feedback?: string }>;
}

export type PermissionKind = keyof PermissionDecisionByKind;

export type PermissionDecision<K extends PermissionKind> =
  PermissionDecisionByKind[K];

type PermissionKindsWithAction<A extends string> = {
  [K in PermissionKind]: Extract<
    PermissionDecisionByKind[K],
    { action: A }
  > extends never
    ? never
    : K;
}[PermissionKind];

export type FeedbackPermissionKind = PermissionKindsWithAction<'reject'>;
export type ApprovalPermissionKind = PermissionKindsWithAction<'approve'>;
export type ApprovalDecision<K extends ApprovalPermissionKind> = Extract<
  PermissionDecisionByKind[K],
  { action: 'approve' }
>;
