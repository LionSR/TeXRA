/** Base class shared by all request panel types. */

// Third-party imports
import { LitElement } from 'lit';
import { property } from 'lit/decorators.js';

// Local imports - shared schemas
import type { PermissionPayload } from '@shared/schemas';
import { getExhaustionReason } from '@shared/schemas';
import type { HostRequest } from '@shared/session/hostRequest';
import {
  SessionUiEvents,
  type RuntimeRequestDetail,
} from '@shared/session/uiEvents';

// Local imports - progress view events
import {
  APPROVE_ALL_DELEGATED_WORK_ACTION,
  APPROVE_SESSION_ACTION,
  type PermissionDecision,
  type PermissionKind,
} from '../events';

type Arm =
  { readonly runtime: RuntimeRequestDetail } | { readonly host: HostRequest };

/**
 * The arms one decision names (PRD 8.2): a session-wide approval is the
 * bypass change and the approval itself, in that order; a tool-edit
 * preview is a host capability that leaves the approval pending.
 */
function decisionArms<K extends PermissionKind>(
  permission: Extract<PermissionPayload, { kind: K }>,
  decision: PermissionDecision<K>,
): Arm[] {
  const { streamId, requestId: approvalId } = permission.data;
  const bypass = (kind: 'bash' | 'toolEdit' | 'superYolo'): Arm => ({
    runtime: {
      kind: 'policy.set',
      change: { field: 'bypass', streamId, bypass: kind, enabled: true },
    },
  });
  switch (permission.kind) {
    case 'toolEdit': {
      const d = decision as PermissionDecision<'toolEdit'>;
      if (d.action === 'approve' || d.action === APPROVE_SESSION_ACTION) {
        const approve: Arm = {
          runtime: {
            kind: 'decision.toolEdit',
            streamId,
            approvalId,
            decision: { action: 'approve' },
          },
        };
        return d.action === 'approve'
          ? [approve]
          : [bypass('toolEdit'), approve];
      }
      if (d.action === 'reject') {
        return [
          {
            runtime: {
              kind: 'decision.toolEdit',
              streamId,
              approvalId,
              decision: { action: 'reject', feedback: d.feedback ?? null },
            },
          },
        ];
      }
      return [
        {
          host: {
            kind: 'toolEditPreview',
            requestId: approvalId,
            action: d.action,
          },
        },
      ];
    }
    case 'bash': {
      const d = decision as PermissionDecision<'bash'>;
      const approve: Arm = {
        runtime: {
          kind: 'decision.bash',
          streamId,
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
      const { data } = permission as Extract<
        PermissionPayload,
        { kind: 'retry' }
      >;
      if (d.action === 'useOwnApiKey') {
        return [
          {
            runtime: {
              kind: 'credentials.useOwnApiKey',
              streamId,
              approvalId,
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
            streamId,
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
          RuntimeRequestDetail,
          { kind: 'decision.proposal' }
        >['decision'],
      ): Arm => ({
        runtime: {
          kind: 'decision.proposal',
          streamId,
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
            streamId,
            approvalId,
            decision:
              d.action === 'reject'
                ? { action: 'reject', feedback: d.feedback ?? null }
                : { action: d.action },
          },
        },
      ];
    }
    case 'externalInquiry': {
      const d = decision as PermissionDecision<'externalInquiry'>;
      const { threadId } = (
        permission as Extract<PermissionPayload, { kind: 'externalInquiry' }>
      ).data;
      return [
        {
          runtime:
            d.action === 'submit'
              ? {
                  kind: 'externalInquiry.submit',
                  streamId,
                  threadId,
                  answer: d.answer,
                  sessionLinks: d.sessionLinks ?? null,
                }
              : {
                  kind: 'externalInquiry.drop',
                  streamId,
                  threadId,
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
            streamId,
            approvalId,
            decision: userQuestionDecision(d),
          },
        },
      ];
    }
  }
}

function userQuestionDecision(
  d: PermissionDecision<'userQuestion'>,
): Extract<
  RuntimeRequestDetail,
  { kind: 'decision.userQuestion' }
>['decision'] {
  if (d.action === 'submit') return { action: 'submit', answers: d.answers };
  if (d.action === 'skip')
    return { action: 'skip', feedback: d.feedback ?? null };
  return { action: 'reject', feedback: d.feedback ?? null };
}

export abstract class BaseRequestPanel<
  K extends PermissionKind = PermissionKind,
> extends LitElement {
  @property({ attribute: false }) permission!: Extract<
    PermissionPayload,
    { kind: K }
  >;

  /**
   * The stream's `readOnly` (PRD 5.2): another live owner holds it, it is
   * unreadable, or the surface is an archived export with no backend for a
   * decision to reach. The single chokepoint every subclass's buttons and
   * keyboard shortcuts call through (`emitAction`) no-ops here, so no
   * subclass has to remember to check this itself.
   */
  @property({ type: Boolean }) readOnly = false;

  /** Handle keyboard shortcut from container. Returns true if handled. */
  abstract handleKeyboardShortcut(key: string): boolean;

  protected emitAction(decision: PermissionDecision<K>): void {
    if (this.readOnly) return;
    for (const arm of decisionArms(this.permission, decision)) {
      this.dispatchEvent(
        'runtime' in arm
          ? SessionUiEvents.runtime(arm.runtime)
          : SessionUiEvents.host(arm.host),
      );
    }
  }
}
