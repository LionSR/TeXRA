/**
 * What a surface offers and sends for a pending request: the answers each
 * kind offers ({@link REQUEST_ACTIONS}) and the `request.decide` or
 * `host.request` case one decision names. The progress view's request
 * panels, the TUI's approval modal and the headless prompt read here, so one
 * answer means one thing on all of them.
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
 * Surface-only approval action emitted by the run-grant item and `a` key on
 * the command, edit and agent-proposal prompts. It never becomes a durable
 * decision: {@link approvalDecisionArm} sends it as a plain approve that
 * grants the request kind's bypass for the run.
 */
export const APPROVE_SESSION_ACTION = 'approveSession';

/** A tool-edit prompt's verbs over the preview the host staged; they leave
 *  the request pending. */
type ToolEditPreviewAction = 'openDiff' | 'showLatexdiff' | 'previewProposed';

/**
 * What a surface emits for one request: a durable {@link RequestDecision},
 * the run-grant approval, or a tool-edit preview verb.
 */
export type SurfaceDecision =
  | RequestDecision
  | {
      readonly action: typeof APPROVE_SESSION_ACTION;
      /** The model an agent-proposal card picked, when it is not the
       *  proposal's. */
      readonly model?: string;
    }
  | { readonly action: ToolEditPreviewAction };

/** How a prompt declines: with a note the agent reads (`reject`), by passing
 *  on it (`skip`), or by stopping the task (`stop`, sent as a `cancel`). */
type RequestDecline = 'reject' | 'skip' | 'stop';

const APPROVE = Object.freeze({ action: 'approve' });

/**
 * The answers each request kind offers, by the key every surface binds them
 * to: `y` the primary answer (none for a question, whose answers are its
 * form's), `n` how it declines, and the kind's own keys. Labels are each
 * surface's; what a key sends is this table's. The `a` run grant of a kind
 * with a bypass is {@link APPROVE_SESSION_ACTION}, and a key the request
 * itself must allow (a retry's move onto the user's own key) is checked by
 * the surface and again by {@link approvalDecisionArm}.
 */
export const REQUEST_ACTIONS = Object.freeze({
  bash: Object.freeze({ y: APPROVE, n: 'reject' }),
  toolEdit: Object.freeze({ y: APPROVE, n: 'reject' }),
  proposal: Object.freeze({ y: APPROVE, n: 'reject' }),
  planApproval: Object.freeze({
    y: APPROVE,
    n: 'reject',
    /** Run as goal, auto-approving commands only. */
    r: Object.freeze({ action: 'approve_and_goal' }),
    /** Run as goal, also approving edits and agent work. */
    a: Object.freeze({ action: 'approve_and_goal', autoApproveAll: true }),
  }),
  retry: Object.freeze({
    y: Object.freeze({ action: 'retry' }),
    n: 'stop',
    k: Object.freeze({ action: 'retry', credentials: 'personal' }),
  }),
  userQuestion: Object.freeze({ n: 'skip' }),
  plugin: Object.freeze({ n: 'skip' }),
}) satisfies {
  readonly [K in PermissionPayload['kind']]: {
    readonly n: RequestDecline;
    readonly [key: string]: SurfaceDecision | RequestDecline;
  };
};

/** The decision a `kind` request's decline sends, with the user's note on
 *  it when there is one. */
export function declineDecision(
  kind: PermissionPayload['kind'],
  note?: string,
): RequestDecision {
  const decline: RequestDecline = REQUEST_ACTIONS[kind].n;
  switch (decline) {
    case 'reject':
      return { action: 'reject', feedback: note };
    case 'skip':
      return { action: 'skip', feedback: note };
    case 'stop':
      return { action: 'cancel', cause: note };
  }
}

/**
 * The wire case a decision names: a request to the run's runtime, or a
 * capability only the host can perform. A tool edit's verbs act on the
 * preview the host staged and a retry's own-key switch stores a credential,
 * so those two kinds are the only ones that name a host case.
 */
type ApprovalArm =
  | { readonly runtime: RuntimeRequest }
  | { readonly host: HostRequest };

const BYPASS_OF_KIND: Partial<
  Record<PermissionPayload['kind'], ApprovalBypassKind>
> = {
  toolEdit: 'toolEdit',
  bash: 'bash',
  proposal: 'superYolo',
};

/**
 * The case one decision names: a session-wide approval is the approval with
 * its bypass `grant`; a tool-edit preview verb is a host capability that
 * leaves the request pending; a retry on the user's own key is the host's
 * `useOwnApiKey`, which stores the key and then decides the retry itself.
 * Everything else is a plain `request.decide`.
 */
export function approvalDecisionArm(
  permission: PendingRequest['payload'],
  decision: SurfaceDecision,
): ApprovalArm {
  const { runId, requestId } = permission.data;
  if (runId === '') {
    throw new Error(
      `Permission ${permission.kind}:${requestId} names no run to decide on.`,
    );
  }
  const decide = (
    d: RequestDecision,
    grant?: ApprovalBypassKind,
  ): ApprovalArm => ({
    runtime: { kind: 'request.decide', runId, requestId, decision: d, grant },
  });
  switch (decision.action) {
    case APPROVE_SESSION_ACTION: {
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
      return decide(
        {
          action: 'approve',
          ...('model' in decision && decision.model !== undefined
            ? { model: decision.model }
            : {}),
        },
        bypass,
      );
    }
    case 'openDiff':
    case 'showLatexdiff':
    case 'previewProposed':
      return { host: { kind: 'toolEdit', requestId, action: decision.action } };
    case 'retry': {
      if (decision.credentials !== 'personal' || permission.kind !== 'retry') {
        return decide(decision);
      }
      const { data } = permission;
      if (data.credentialSwitch == null) {
        throw new Error(
          `Retry ${requestId} offers no move onto the user's own credential.`,
        );
      }
      return {
        host: {
          kind: 'useOwnApiKey',
          runId,
          requestId,
          credentialSwitch: data.credentialSwitch,
        },
      };
    }
    case 'approve':
    case 'approve_and_goal':
    case 'submit':
    case 'answer':
    case 'skip':
    case 'reject':
    case 'deny':
    case 'cancel':
      return decide(decision);
    default:
      return decision satisfies never;
  }
}
