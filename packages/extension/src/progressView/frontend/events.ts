/**
 * Typed custom events for ProgressView components.
 * Both dispatch and handler sides use these types.
 */

import type {
  GettingStartedActionDetail,
  UserQuestionAnswers,
} from '@shared/schemas';
import { createEvent } from '@shared/utils/events';
import type { ExtractedClipboardImage } from '@shared/utils/clipboardImages';

import type { PermissionState } from './permissionState';

// =============================================================================
// Event Detail Types
// =============================================================================

export interface StreamEventDetail {
  streamId: string;
}

export interface ToolbarCommandDetail {
  command: string;
}

export interface FollowUpChangeDetail {
  readonly streamId: string;
  readonly value: string;
  /** Append is used when an async paste finishes after its stream is hidden. */
  readonly mode?: 'replace' | 'append';
}

/** Images pasted into the follow-up box, carried with the send event. */
export interface FollowUpSendDetail {
  readonly streamId: string;
  readonly images: readonly ExtractedClipboardImage[];
}

export interface FollowupCommandDetail {
  agent: string;
  model: string;
  initialQuestion: string;
}

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

/** A permission and the only decisions valid for that permission kind. */
export type PermissionActionDetail<K extends PermissionKind = PermissionKind> =
  {
    [P in K]: Extract<PermissionState, { kind: P }> & {
      decision: PermissionDecision<P>;
    };
  }[K];

/**
 * Detail for file-related actions in ProgressView.
 * Named to distinguish from mainView's FileActionDetail which has different fields.
 */
export interface ProgressFileActionDetail {
  command: string;
  file: string;
  base?: string;
  prev?: string;
}

// =============================================================================
// Event Creators - use these to dispatch typed events
// =============================================================================

export const ProgressEvents = {
  streamSwitch: (detail: StreamEventDetail) =>
    createEvent('stream-switch', detail),

  streamDelete: (detail: StreamEventDetail) =>
    createEvent('stream-delete', detail),

  toolbarCommand: (detail: ToolbarCommandDetail) =>
    createEvent('toolbar-command', detail),

  fileAction: (detail: ProgressFileActionDetail) =>
    createEvent('file-action', detail),

  followupChange: (detail: FollowUpChangeDetail) =>
    createEvent('followup-change', detail),

  followupSend: (detail: FollowUpSendDetail) =>
    createEvent('followup-send', detail),

  followupPolish: () => createEvent('followup-polish', undefined),

  followupRequestOptions: () =>
    createEvent('followup-request-options', undefined),

  followupSetup: (detail: FollowupCommandDetail) =>
    createEvent('followup-setup', detail),

  followupRun: (detail: FollowupCommandDetail) =>
    createEvent('followup-run', detail),

  compileFixerRun: () => createEvent('compile-fixer-run', undefined),

  permissionAction: <K extends PermissionKind>(
    permission: Extract<PermissionState, { kind: K }>,
    decision: PermissionDecision<K>,
  ) => createEvent('permission-action', { ...permission, decision }),

  fileClick: (detail: { file: string; line?: number }) =>
    createEvent('file-click', detail),

  focusComplete: () => createEvent('focus-complete', undefined),

  followupFocusComplete: () =>
    createEvent('followup-focus-complete', undefined),

  gettingStartedAction: (detail: GettingStartedActionDetail) =>
    createEvent('getting-started-action', detail),
} as const;
