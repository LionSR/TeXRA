import type { AgentTrace } from '@agent/trace';
import {
  type BashSettlement,
  type HostApprovalBypassStateUpdate,
  matchesCancelSelector,
  type HostInteractionCancelSelector,
  type UserQuestionSettlement,
  type PendingInteractionKind,
  type PlanApprovalResult,
  type ProposalResult,
  type RetryResult,
  type SettledInteractionKind,
} from '@agent/runtime/HostInteractions';
import type {
  AgentProposalPermission,
  BashPermission,
  ExternalInquiryPermission,
  PlanApprovalPermission,
  PermissionPayload,
  RetryPermission,
  ToolEditPermission,
  UserQuestionPermission,
} from '@shared/schemas';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';

import { ApprovalRequestHandler } from './ApprovalRequestHandler';
import { ExternalInquiryRequestHandler } from './ExternalInquiryRequestHandler';
import type { WebviewUpdater } from './WebviewUpdater';

/**
 * The seven pending-approval handlers a progress backend wires. Hosts build
 * each handler with their own show/dismiss transport (and `canSend` gate), then
 * hand the set to {@link createProgressBackendUiConfig}, which derives the
 * uniform UI callbacks and the pending-permissions guard from them.
 */
export interface ApprovalRequestHandlerSet {
  toolEdit: ApprovalRequestHandler<ToolEditPermission, 'requestId'>;
  bash: ApprovalRequestHandler<BashPermission, 'requestId', BashSettlement>;
  retry: ApprovalRequestHandler<RetryPermission, 'streamId', RetryResult>;
  proposal: ApprovalRequestHandler<
    AgentProposalPermission,
    'proposalId',
    ProposalResult
  >;
  planApproval: ApprovalRequestHandler<
    PlanApprovalPermission,
    'approvalId',
    PlanApprovalResult
  >;
  externalInquiry: ApprovalRequestHandler<
    ExternalInquiryPermission,
    'requestId'
  >;
  userQuestion: ApprovalRequestHandler<
    UserQuestionPermission,
    'requestId',
    UserQuestionSettlement
  >;
}

/** Everything the cancellation sweep needs from one handler, so the set can be
 *  indexed by interaction kind without narrowing to a concrete payload type. */
interface CancellableApprovalRequestHandler {
  cancelWhere(
    predicate: (
      item: { readonly streamId: string },
      cancellationScope?: object,
    ) => boolean,
    cause?: string,
  ): number;
}

/** Cancel the response-bearing progress interactions supported by one host. */
export function cancelApprovalRequestHandlers(
  handlers: ApprovalRequestHandlerSet,
  kinds: readonly SettledInteractionKind[],
  selector: HostInteractionCancelSelector,
): number {
  let cancelled = 0;
  for (const kind of kinds) {
    const handler: CancellableApprovalRequestHandler = handlers[kind];
    cancelled += handler.cancelWhere(
      (item, cancellationScope) =>
        matchesCancelSelector(
          {
            kind,
            streamId: item.streamId || undefined,
            cancellationScope,
          },
          selector,
        ),
      selector.cause,
    );
  }
  return cancelled;
}

type ReplayableApprovalRequestHandlerSet = {
  [K in keyof ApprovalRequestHandlerSet]: Pick<
    ApprovalRequestHandlerSet[K],
    'replay'
  >;
};

/**
 * The full key set of {@link ApprovalRequestHandlerSet}, enforced exhaustive
 * via `satisfies` against both the interface and the shared interaction-kind
 * vocabulary: the handler keys are the kinds, so renaming either side fails
 * here instead of silently dropping a kind. It also keeps
 * {@link replayApprovalRequestHandlers} and the `hasPendingPermissions` guard
 * below in sync with the interface.
 */
const APPROVAL_REQUEST_HANDLER_KEY_MAP = {
  toolEdit: true,
  bash: true,
  externalInquiry: true,
  retry: true,
  proposal: true,
  planApproval: true,
  userQuestion: true,
} satisfies Record<keyof ApprovalRequestHandlerSet, true> &
  Record<PendingInteractionKind, true>;

const APPROVAL_REQUEST_HANDLER_KEYS = Object.keys(
  APPROVAL_REQUEST_HANDLER_KEY_MAP,
) as Array<keyof ApprovalRequestHandlerSet>;

/**
 * Host-specific show/dismiss transport for one approval kind. Every host
 * supplies retry behavior. A host may override agent proposals when it needs
 * richer presentation data than the built-in permission handler provides.
 */
interface ApprovalHandlerTransport<T> {
  show: (item: T) => void;
  dismiss: (id: string) => void;
}

interface ApprovalRequestHandlerOverrides {
  retry: ApprovalHandlerTransport<RetryPermission>;
  proposal?: ApprovalHandlerTransport<AgentProposalPermission>;
}

export interface BuildApprovalRequestHandlerSetParams {
  webviewUpdater: WebviewUpdater;
  /** Gate passed to every handler; an empty/false gate keeps it pending-only. */
  canSend: () => boolean;
  logger?: Pick<AgentTrace, 'debug'>;
  overrides: ApprovalRequestHandlerOverrides;
}

type PermissionData<K extends PermissionPayload['kind']> = Extract<
  PermissionPayload,
  { kind: K }
>['data'] & { streamId: string };

function webviewPermissionHandler<
  K extends PermissionPayload['kind'],
  IdField extends keyof PermissionData<K>,
  Result = never,
>(
  webviewUpdater: WebviewUpdater,
  canSend: () => boolean,
  kind: K,
  idField: IdField,
): ApprovalRequestHandler<PermissionData<K>, IdField, Result> {
  return new ApprovalRequestHandler(
    idField,
    (data) =>
      webviewUpdater.showPermission({
        kind,
        data,
      } as Extract<PermissionPayload, { kind: K }>),
    (id) => webviewUpdater.resolvePermission(kind, id),
    canSend,
  );
}

export function buildApprovalRequestHandlerSet(
  params: BuildApprovalRequestHandlerSetParams,
): ApprovalRequestHandlerSet {
  const { webviewUpdater, canSend, overrides } = params;
  return {
    toolEdit: webviewPermissionHandler(
      webviewUpdater,
      canSend,
      PERMISSION_KIND.TOOL_EDIT,
      'requestId',
    ),
    bash: webviewPermissionHandler<
      typeof PERMISSION_KIND.BASH,
      'requestId',
      BashSettlement
    >(webviewUpdater, canSend, PERMISSION_KIND.BASH, 'requestId'),
    planApproval: webviewPermissionHandler<
      typeof PERMISSION_KIND.PLAN_APPROVAL,
      'approvalId',
      PlanApprovalResult
    >(webviewUpdater, canSend, PERMISSION_KIND.PLAN_APPROVAL, 'approvalId'),
    externalInquiry: new ExternalInquiryRequestHandler({
      show: (data) =>
        webviewUpdater.showPermission({
          kind: PERMISSION_KIND.EXTERNAL_INQUIRY,
          data,
        }),
      dismiss: (id) =>
        webviewUpdater.resolvePermission(PERMISSION_KIND.EXTERNAL_INQUIRY, id),
      syncThreads: (threads) => webviewUpdater.syncInquiryThreads(threads),
      canSend,
      logger: params.logger,
    }),
    userQuestion: webviewPermissionHandler<
      typeof PERMISSION_KIND.USER_QUESTION,
      'requestId',
      UserQuestionSettlement
    >(webviewUpdater, canSend, PERMISSION_KIND.USER_QUESTION, 'requestId'),
    retry: new ApprovalRequestHandler<RetryPermission, 'streamId', RetryResult>(
      'streamId',
      overrides.retry.show,
      overrides.retry.dismiss,
      canSend,
    ),
    proposal: overrides.proposal
      ? new ApprovalRequestHandler<
          AgentProposalPermission,
          'proposalId',
          ProposalResult
        >(
          'proposalId',
          overrides.proposal.show,
          overrides.proposal.dismiss,
          canSend,
        )
      : webviewPermissionHandler<
          typeof PERMISSION_KIND.PROPOSAL,
          'proposalId',
          ProposalResult
        >(webviewUpdater, canSend, PERMISSION_KIND.PROPOSAL, 'proposalId'),
  };
}

export async function replayApprovalRequestHandlers(
  handlers: ReplayableApprovalRequestHandlerSet,
): Promise<void> {
  await Promise.all(
    APPROVAL_REQUEST_HANDLER_KEYS.map((key) => handlers[key].replay()),
  );
}

interface ProgressBackendUiConfig {
  setApprovalBypassState(update: HostApprovalBypassStateUpdate): void;
  hasPendingPermissions(streamId: string): boolean;
}

interface ProgressBackendUiConfigParams {
  handlers: ApprovalRequestHandlerSet;
  /** Transport for approval-bypass state (handlers own their own transport). */
  webviewUpdater: WebviewUpdater;
  /** Gate shared with the handlers; also guards the bypass-state pushes. */
  canSend: () => boolean;
}

/**
 * Build the host-neutral bypass-state transport and pending-permissions guard
 * from a set of {@link ApprovalRequestHandler}s.
 *
 * The guard checks `hasPendingForStream` across all handlers (see
 * {@link APPROVAL_REQUEST_HANDLER_KEYS}), reusing the handler's
 * empty-streamId-blocks-all rule instead of re-deriving it per host.
 */
export function createProgressBackendUiConfig(
  params: ProgressBackendUiConfigParams,
): ProgressBackendUiConfig {
  const { handlers, webviewUpdater, canSend } = params;
  return {
    setApprovalBypassState: ({ streamId, kind, bypassActive }) => {
      if (canSend()) {
        webviewUpdater.updateBypassState(streamId, kind, bypassActive);
      }
    },
    hasPendingPermissions: (streamId) =>
      APPROVAL_REQUEST_HANDLER_KEYS.some((key) =>
        handlers[key].hasPendingForStream(streamId),
      ),
  };
}
