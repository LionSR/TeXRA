/**
 * The approval decision vocabulary and the arms one decision names (PRD
 * one-fold-three-renderers, 8.2): what each permission kind may be answered
 * with, and the `policy.set` / `decision.*` / `host.request` arms that answer
 * carries. Both surfaces that present approvals — the progress view's request
 * panels and the TUI's approval modal — map through here, so one decision
 * means one thing on both.
 *
 * Pure and host-neutral: it reaches `@shared/schemas` and the two request
 * protocols beside it, and nothing else.
 */

import type {
  PermissionPayload,
  RunId,
  UserQuestionAnswers,
} from '@shared/schemas';
import { getExhaustionReason } from '@shared/schemas';
import type { ApprovalBypassKind } from '@shared/approvalBypassKind';

import type { HostRequest } from './hostRequest';
import type { RuntimeRequest } from './runtimeRequest';

/**
 * Surface-only approval action emitted by the inline edit/command approval
 * button / `a` shortcut on the edit and bash approval prompts. It never
 * reaches the backend approval protocol: {@link approvalDecisionArms}
 * decomposes it into a normal approve plus a session-bypass enable. Single
 * source of truth shared by the surfaces that emit it.
 */
export const APPROVE_SESSION_ACTION = 'approveSession';

/**
 * Surface-only approval action emitted by the approve-all-delegated-work item
 * on the agent-proposal Approve menu. Like {@link APPROVE_SESSION_ACTION},
 * {@link approvalDecisionArms} decomposes it — into a normal proposal approve
 * plus a per-stream delegated-work bypass enable — so it never reaches the
 * backend proposal protocol (whose action enum stays
 * `approve | reject | setup`).
 */
export const APPROVE_ALL_DELEGATED_WORK_ACTION = 'approveSuperYolo';

interface PermissionPayloadFields {
  feedback: string;
  model: string;
  agent: string;
  answer: string;
  sessionLinks: string[];
  answers: UserQuestionAnswers;
  autoApproveAll: true;
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
    | Decision<'approve'>
    | Decision<'approve_and_goal', { autoApproveAll?: true }>
    | RejectDecision;
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

/** The plain-approve arm of a kind that has one. Named for the action, not
 *  the domain: `ApprovalDecision` is already the host-neutral decision record
 *  at `@shared/schemas`. */
export type ApproveDecision<K extends ApprovalPermissionKind> = Extract<
  PermissionDecisionByKind[K],
  { action: 'approve' }
>;

/**
 * One wire arm a decision names: a request to the run's runtime, or a
 * capability only the host can perform. A tool edit's verbs act on the
 * preview the host staged and a retry's own-key switch stores a credential,
 * so those two kinds are the only ones that name a host arm.
 */
type ApprovalArm =
  { readonly runtime: RuntimeRequest } | { readonly host: HostRequest };

/** Kinds whose every arm is a runtime request, so a surface that answers only
 *  through the request protocol dispatches them with no host branch. */
type RuntimeOnlyPermissionKind = Exclude<PermissionKind, 'toolEdit' | 'retry'>;

/** Enable a session-wide bypass on one stream: the field-level mutation the
 *  approval authority applies, not a snapshot. */
function sessionBypassRequest(
  runId: RunId,
  bypass: ApprovalBypassKind,
): Extract<RuntimeRequest, { kind: 'policy.set' }> {
  return {
    kind: 'policy.set',
    change: { field: 'bypass', runId, bypass, enabled: true },
  };
}

/**
 * The arms one decision names (PRD 8.2): a session-wide approval is the
 * bypass change and the approval itself, in that order; a tool-edit preview
 * is a host capability that leaves the approval pending.
 */
export function approvalDecisionArms<K extends RuntimeOnlyPermissionKind>(
  permission: Extract<PermissionPayload, { kind: K }>,
  decision: PermissionDecision<K>,
): readonly { readonly runtime: RuntimeRequest }[];
export function approvalDecisionArms<K extends PermissionKind>(
  permission: Extract<PermissionPayload, { kind: K }>,
  decision: PermissionDecision<K>,
): readonly ApprovalArm[];
export function approvalDecisionArms(
  permission: PermissionPayload,
  decision: PermissionDecision<PermissionKind>,
): readonly ApprovalArm[] {
  const { runId, requestId: approvalId } = permission.data;
  if (runId === '') {
    throw new Error(
      `Permission ${permission.kind}:${approvalId} names no run to decide on.`,
    );
  }
  const bypass = (kind: ApprovalBypassKind): ApprovalArm => ({
    runtime: sessionBypassRequest(runId, kind),
  });
  switch (permission.kind) {
    case 'toolEdit': {
      // The host staged the preview and applies the proposed file as the
      // user left it, so every tool-edit verb is a host capability.
      const d = decision as PermissionDecision<'toolEdit'>;
      const host = (
        action: Extract<HostRequest, { kind: 'toolEdit' }>['action'],
        feedback?: string | null,
      ): ApprovalArm => ({
        host: {
          kind: 'toolEdit',
          requestId: approvalId,
          action,
          feedback: feedback ?? null,
        },
      });
      if (d.action === APPROVE_SESSION_ACTION) {
        return [bypass('toolEdit'), host('approve')];
      }
      if (d.action === 'reject') return [host('reject', d.feedback)];
      return [host(d.action)];
    }
    case 'bash': {
      const d = decision as PermissionDecision<'bash'>;
      const approve: ApprovalArm = {
        runtime: {
          kind: 'decision.bash',
          runId,
          approvalId,
          decision:
            d.action === 'reject'
              ? { action: 'reject', feedback: d.feedback ?? null }
              : { action: 'approve' },
        },
      };
      return d.action === APPROVE_SESSION_ACTION
        ? [bypass('bash'), approve]
        : [approve];
    }
    case 'retry': {
      const d = decision as PermissionDecision<'retry'>;
      const { data } = permission;
      if (d.action === 'useOwnApiKey') {
        return [
          {
            host: {
              kind: 'useOwnApiKey',
              runId,
              requestId: approvalId,
              model: data.model,
              provider: data.errorDetails?.provider ?? null,
              exhaustionReason: getExhaustionReason(data.errorDetails),
              kimiCodeRoutedOnFailure: data.kimiCodeRoutedOnFailure ?? null,
            },
          },
        ];
      }
      return [
        {
          runtime: {
            kind: 'decision.retry',
            runId,
            approvalId,
            decision:
              d.action === 'retry' ? { action: 'retry' } : { action: 'cancel' },
          },
        },
      ];
    }
    case 'proposal': {
      const d = decision as PermissionDecision<'proposal'>;
      const arm = (
        inner: Extract<
          RuntimeRequest,
          { kind: 'decision.proposal' }
        >['decision'],
      ): ApprovalArm => ({
        runtime: {
          kind: 'decision.proposal',
          runId,
          approvalId,
          decision: inner,
        },
      });
      if (d.action === 'reject') {
        return [arm({ action: 'reject', feedback: d.feedback ?? null })];
      }
      if (d.action === 'setup') return [arm({ action: 'setup' })];
      const approve = arm({
        action: 'approve',
        model: d.model ?? null,
        agent: d.agent ?? null,
      });
      return d.action === APPROVE_ALL_DELEGATED_WORK_ACTION
        ? [bypass('superYolo'), approve]
        : [approve];
    }
    case 'planApproval': {
      const d = decision as PermissionDecision<'planApproval'>;
      return [
        {
          runtime: {
            kind: 'decision.plan',
            runId,
            approvalId,
            decision: planDecision(d),
          },
        },
      ];
    }
    case 'externalInquiry': {
      const d = decision as PermissionDecision<'externalInquiry'>;
      const { threadId, transcript } = permission.data;
      return [
        {
          runtime:
            d.action === 'submit'
              ? {
                  kind: 'externalInquiry.submit',
                  runId,
                  threadId,
                  turnIndex: transcript?.at(-1)?.turnIndex ?? 1,
                  answer: d.answer,
                  sessionLinks: d.sessionLinks ?? null,
                }
              : {
                  kind: 'externalInquiry.drop',
                  runId,
                  threadId,
                  turnIndex: transcript?.at(-1)?.turnIndex ?? 1,
                  feedback: d.feedback ?? null,
                },
        },
      ];
    }
    case 'userQuestion': {
      const d = decision as PermissionDecision<'userQuestion'>;
      return [
        {
          runtime: {
            kind: 'decision.userQuestion',
            runId,
            approvalId,
            decision: userQuestionDecision(d),
          },
        },
      ];
    }
  }
}

function planDecision(
  d: PermissionDecision<'planApproval'>,
): Extract<RuntimeRequest, { kind: 'decision.plan' }>['decision'] {
  if (d.action === 'reject')
    return { action: 'reject', feedback: d.feedback ?? null };
  if (d.action === 'approve_and_goal') {
    return {
      action: 'approve_and_goal',
      autoApproveAll: d.autoApproveAll ?? null,
    };
  }
  return { action: 'approve' };
}

function userQuestionDecision(
  d: PermissionDecision<'userQuestion'>,
): Extract<RuntimeRequest, { kind: 'decision.userQuestion' }>['decision'] {
  if (d.action === 'submit') return { action: 'submit', answers: d.answers };
  if (d.action === 'skip')
    return { action: 'skip', feedback: d.feedback ?? null };
  return { action: 'reject', feedback: d.feedback ?? null };
}
