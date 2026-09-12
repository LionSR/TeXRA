/**
 * What a surface does with one decision on a pending request (PRD
 * one-fold-three-renderers, 8.2): the `request.decide`, `policy.set`, and
 * `host.request` arms it names, and the one wording of a refusal. Both
 * surfaces that present requests, the progress view's request panels and the
 * TUI's approval modal, map through here, so one decision means one thing on
 * both.
 *
 * Pure and host-neutral: it reaches `@shared/schemas` and the two request
 * protocols beside it, and nothing else.
 */

import type {
  PermissionPayload,
  RequestDecision,
  RequestRefusal,
  RunId,
} from '@shared/schemas';
import { getExhaustionReason, isRequestRefusal } from '@shared/schemas';
import type { ApprovalBypassKind } from '@shared/approvalBypassKind';

import type { HostRequest } from './hostRequest';
import type { RuntimeRequest } from './runtimeRequest';

/**
 * Surface-only approval action emitted by the inline edit/command approval
 * button / `a` shortcut on the edit and bash approval prompts. It never
 * becomes a durable decision: {@link approvalDecisionArms} decomposes it into
 * a plain approve plus a session-bypass enable (ruling A9-6).
 */
export const APPROVE_SESSION_ACTION = 'approveSession';

/**
 * Surface-only approval action emitted by the approve-all-delegated-work item
 * on the agent-proposal Approve menu. Like {@link APPROVE_SESSION_ACTION},
 * {@link approvalDecisionArms} decomposes it into a plain proposal approve
 * plus a per-run delegated-work bypass enable.
 */
export const APPROVE_ALL_DELEGATED_WORK_ACTION = 'approveSuperYolo';

/** A tool-edit prompt's verbs over the preview the host staged; they leave
 *  the request pending. */
type ToolEditPreviewAction = 'openDiff' | 'showLatexdiff' | 'previewProposed';

/**
 * What a surface emits for one request: a durable {@link RequestDecision},
 * one of the two session-bypass approvals, or a tool-edit preview verb.
 */
export type SurfaceDecision =
  | RequestDecision
  | { readonly action: typeof APPROVE_SESSION_ACTION }
  | {
      readonly action: typeof APPROVE_ALL_DELEGATED_WORK_ACTION;
      readonly model?: string | null;
      readonly agent?: string | null;
    }
  | { readonly action: ToolEditPreviewAction };

/**
 * One wire arm a decision names: a request to the run's runtime, or a
 * capability only the host can perform. A tool edit's verbs act on the
 * preview the host staged and a retry's own-key switch stores a credential,
 * so those two kinds are the only ones that name a host arm.
 */
export type ApprovalArm =
  { readonly runtime: RuntimeRequest } | { readonly host: HostRequest };

/** Enable a session-wide bypass on one run: the field-level mutation the
 *  approval authority applies, not a snapshot. */
export function sessionBypassRequest(
  runId: RunId,
  bypass: ApprovalBypassKind,
): Extract<RuntimeRequest, { kind: 'policy.set' }> {
  return {
    kind: 'policy.set',
    change: { field: 'bypass', runId, bypass, enabled: true },
  };
}

const BYPASS_OF_KIND: Partial<
  Record<PermissionPayload['kind'], ApprovalBypassKind>
> = {
  toolEdit: 'toolEdit',
  bash: 'bash',
  proposal: 'superYolo',
};

/**
 * The arms one decision names (PRD 8.2): a session-wide approval is the
 * bypass change and the approval itself, in that order; a tool-edit preview
 * verb is a host capability that leaves the request pending; a retry on the
 * user's own key is the host's `useOwnApiKey`, which stores the key and then
 * decides the retry itself. Everything else is one `request.decide`.
 */
export function approvalDecisionArms(
  permission: PermissionPayload,
  decision: SurfaceDecision,
): readonly ApprovalArm[] {
  const { runId, requestId } = permission.data;
  if (runId === '') {
    throw new Error(
      `Permission ${permission.kind}:${requestId} names no run to decide on.`,
    );
  }
  const decide = (d: RequestDecision): ApprovalArm => ({
    runtime: { kind: 'request.decide', runId, requestId, decision: d },
  });
  switch (decision.action) {
    case APPROVE_SESSION_ACTION:
    case APPROVE_ALL_DELEGATED_WORK_ACTION: {
      const bypass = BYPASS_OF_KIND[permission.kind];
      if (bypass === undefined) {
        throw new Error(
          `A ${permission.kind} request has no session bypass to enable.`,
        );
      }
      const approve: RequestDecision =
        decision.action === APPROVE_ALL_DELEGATED_WORK_ACTION
          ? {
              action: 'approve',
              model: decision.model ?? null,
              agent: decision.agent ?? null,
            }
          : { action: 'approve' };
      return [
        { runtime: sessionBypassRequest(runId, bypass) },
        decide(approve),
      ];
    }
    case 'openDiff':
    case 'showLatexdiff':
    case 'previewProposed':
      return [
        {
          host: {
            kind: 'toolEdit',
            requestId,
            action: decision.action,
            feedback: null,
          },
        },
      ];
    case 'retry': {
      if (decision.credentials !== 'personal' || permission.kind !== 'retry') {
        return [decide(decision)];
      }
      const { data } = permission;
      return [
        {
          host: {
            kind: 'useOwnApiKey',
            runId,
            requestId,
            model: data.model,
            provider: data.errorDetails?.provider ?? null,
            exhaustionReason: getExhaustionReason(data.errorDetails),
            kimiCodeRoutedOnFailure: data.kimiCodeRoutedOnFailure ?? null,
          },
        },
      ];
    }
    case 'approve':
    case 'approve_and_goal':
    case 'setup':
    case 'submit':
    case 'answer':
    case 'skip':
    case 'reject':
    case 'deny':
    case 'cancel':
      return [decide(decision)];
    default:
      return decision satisfies never;
  }
}

/**
 * A decision that is not one the caller accepts, read as the refusal it is
 * or, for an arm the request's kind never offered (a surface defect), as a
 * loud denial naming it: a run never proceeds on an answer it cannot read.
 */
export function refusalOf(
  kind: PermissionPayload['kind'],
  decision: RequestDecision,
): RequestRefusal {
  if (isRequestRefusal(decision)) return decision;
  return {
    action: 'deny',
    reason: `The ${kind} request was answered with "${decision.action}", which it does not offer.`,
  };
}

/**
 * The one wording of a declined request, over the union's three refusal
 * arms: what the summary says about `subject` (a command, a plan, a
 * delegation), the detail that names why, and the feedback a person left for
 * the agent, which only a `reject` carries.
 */
export function refusalCopy(
  subject: string,
  refusal: RequestRefusal,
): {
  readonly summary: string;
  readonly detail: string | undefined;
  readonly feedback: string | undefined;
} {
  const trimmed = (value: string | null | undefined) => {
    const text = value?.trim();
    return text ? text : undefined;
  };
  switch (refusal.action) {
    case 'deny':
      return {
        summary: `${subject} denied`,
        detail: trimmed(refusal.reason),
        feedback: undefined,
      };
    case 'cancel':
      return {
        summary: `${subject} cancelled`,
        detail: trimmed(refusal.cause),
        feedback: undefined,
      };
    case 'reject':
      return {
        summary: `${subject} rejected by the user`,
        detail: undefined,
        feedback: trimmed(refusal.feedback),
      };
  }
}
