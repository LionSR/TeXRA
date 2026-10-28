/**
 * What a surface does with one decision on a pending request: the
 * `request.decide`, `policy.set`, and
 * `host.request` arms it names. Both surfaces that present requests, the
 * progress view's request panels and the TUI's approval modal, map through
 * here, so one decision means one thing on both.
 *
 * Pure and host-neutral: it reaches the harness's schemas and the two request
 * protocols, and nothing else.
 */

import type {
  ApprovalBypassKind,
  PermissionPayload,
  RequestDecision,
  PendingRequest,
  RuntimeRequest,
} from '@texra-ai/harness/schemas';

import type { HostRequest } from './hostRequest';

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
  | { readonly action: typeof APPROVE_ALL_DELEGATED_WORK_ACTION }
  | { readonly action: ToolEditPreviewAction };

/**
 * One wire arm a decision names: a request to the run's runtime, or a
 * capability only the host can perform. A tool edit's verbs act on the
 * preview the host staged and a retry's own-key switch stores a credential,
 * so those two kinds are the only ones that name a host arm.
 */
type ApprovalArm =
  { readonly runtime: RuntimeRequest } | { readonly host: HostRequest };

const BYPASS_OF_KIND: Partial<
  Record<PermissionPayload['kind'], ApprovalBypassKind>
> = {
  toolEdit: 'toolEdit',
  bash: 'bash',
  proposal: 'superYolo',
};

/**
 * The arms one decision names: a session-wide approval is the
 * bypass change and the approval itself, in that order; a tool-edit preview
 * verb is a host capability that leaves the request pending; a retry on the
 * user's own key is the host's `useOwnApiKey`, which stores the key and then
 * decides the retry itself. Everything else is one `request.decide`.
 */
export function approvalDecisionArms(
  permission: PendingRequest['payload'],
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
      // A command prompt for another tool's call (an MCP tool, codex) does
      // not offer the grant: the only bypass a bash request names is the
      // shell's, and enabling it for that call would approve every command.
      if (
        bypass === undefined ||
        (permission.kind === 'bash' && !permission.data.allowBypass)
      ) {
        throw new Error(
          `A ${permission.kind} request has no session bypass to enable.`,
        );
      }
      // Enable the session-wide bypass first: the field-level mutation the
      // approval authority applies, not a snapshot.
      return [
        {
          runtime: {
            kind: 'policy.set',
            change: {
              field: 'bypass',
              runId,
              bypass,
              enabled: true,
              exceptRequestId: requestId,
            },
          },
        },
        decide({ action: 'approve' }),
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
          },
        },
      ];
    case 'retry': {
      if (decision.credentials !== 'personal' || permission.kind !== 'retry') {
        return [decide(decision)];
      }
      const { data } = permission;
      if (data.credentialSwitch == null) {
        throw new Error(
          `Retry ${requestId} offers no move onto the user's own credential.`,
        );
      }
      return [
        {
          host: {
            kind: 'useOwnApiKey',
            runId,
            requestId,
            credentialSwitch: data.credentialSwitch,
          },
        },
      ];
    }
    case 'approve':
    case 'approve_and_goal':
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
