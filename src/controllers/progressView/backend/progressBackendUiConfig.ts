import type { AgentTrace } from '@agent/trace';
import {
  type HostBashApprovalResult,
  matchesCancelSelector,
  type HostInteractionCancelSelector,
  type HostUserQuestionResult,
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
import { assertNever } from '@utils/core';

import { ApprovalRequestHandler } from './ApprovalRequestHandler';
import { ExternalInquiryRequestHandler } from './ExternalInquiryRequestHandler';
import type { ProgressBackendUiConfig } from './ProgressBackend';
import type { WebviewUpdater } from './WebviewUpdater';

/**
 * The seven pending-approval handlers a progress backend wires. Hosts build
 * each handler with their own show/dismiss transport (and `canSend` gate), then
 * hand the set to {@link createProgressBackendUiConfig}, which derives the
 * uniform UI callbacks and the pending-permissions guard from them.
 */
export interface ApprovalRequestHandlerSet {
  toolEdit: ApprovalRequestHandler<ToolEditPermission, 'requestId'>;
  bash: ApprovalRequestHandler<
    BashPermission,
    'requestId',
    HostBashApprovalResult
  >;
  retry: ApprovalRequestHandler<RetryPermission, 'streamId', RetryResult>;
  agentProposal: ApprovalRequestHandler<
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
    HostUserQuestionResult
  >;
}

function cancelHandler<
  T extends { streamId: string },
  K extends keyof T,
  Result,
>(
  handler: ApprovalRequestHandler<T, K, Result>,
  kind: SettledInteractionKind,
  selector: HostInteractionCancelSelector,
): number {
  return handler.cancelWhere(
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

/** Cancel the response-bearing progress interactions supported by one host. */
export function cancelApprovalRequestHandlers(
  handlers: ApprovalRequestHandlerSet,
  kinds: readonly SettledInteractionKind[],
  selector: HostInteractionCancelSelector,
): number {
  let cancelled = 0;
  for (const kind of kinds) {
    switch (kind) {
      case 'bash':
        cancelled += cancelHandler(handlers.bash, kind, selector);
        break;
      case 'plan':
        cancelled += cancelHandler(handlers.planApproval, kind, selector);
        break;
      case 'proposal':
        cancelled += cancelHandler(handlers.agentProposal, kind, selector);
        break;
      case 'retry':
        cancelled += cancelHandler(handlers.retry, kind, selector);
        break;
      case 'userQuestion':
        cancelled += cancelHandler(handlers.userQuestion, kind, selector);
        break;
      default:
        assertNever(kind, 'Unhandled progress interaction kind');
    }
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
 * via `satisfies`: adding or renaming a handler kind fails this map until
 * it's updated here, which keeps both {@link replayApprovalRequestHandlers}
 * and the `hasPendingPermissions` guard below in sync with the interface.
 */
const APPROVAL_REQUEST_HANDLER_KEY_MAP = {
  toolEdit: true,
  bash: true,
  externalInquiry: true,
  retry: true,
  agentProposal: true,
  planApproval: true,
  userQuestion: true,
} satisfies Record<keyof ApprovalRequestHandlerSet, true>;

const APPROVAL_REQUEST_HANDLER_KEYS = Object.keys(
  APPROVAL_REQUEST_HANDLER_KEY_MAP,
) as Array<keyof ApprovalRequestHandlerSet>;

/**
 * Host-specific show/dismiss transport for one approval kind. retry and
 * agentProposal differ across hosts (the extension shows a retry panel and
 * upgrades proposals with model/agent dropdowns; the desktop cancels retries
 * and shows a plain proposal), so each host supplies these two directly.
 */
interface ApprovalHandlerTransport<T> {
  show: (item: T) => void;
  dismiss: (id: string) => void;
}

interface ApprovalRequestHandlerOverrides {
  retry: ApprovalHandlerTransport<RetryPermission>;
  agentProposal: ApprovalHandlerTransport<AgentProposalPermission>;
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
      HostBashApprovalResult
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
      HostUserQuestionResult
    >(webviewUpdater, canSend, PERMISSION_KIND.USER_QUESTION, 'requestId'),
    retry: new ApprovalRequestHandler<RetryPermission, 'streamId', RetryResult>(
      'streamId',
      overrides.retry.show,
      overrides.retry.dismiss,
      canSend,
    ),
    agentProposal: new ApprovalRequestHandler<
      AgentProposalPermission,
      'proposalId',
      ProposalResult
    >(
      'proposalId',
      overrides.agentProposal.show,
      overrides.agentProposal.dismiss,
      canSend,
    ),
  };
}

export async function replayApprovalRequestHandlers(
  handlers: ReplayableApprovalRequestHandlerSet,
): Promise<void> {
  await Promise.all(
    APPROVAL_REQUEST_HANDLER_KEYS.map((key) => handlers[key].replay()),
  );
}

export interface ProgressBackendUiConfigParams {
  handlers: ApprovalRequestHandlerSet;
  /** Transport for the bypass-state pushes (handlers own their own transport). */
  webviewUpdater: WebviewUpdater;
  /** Gate shared with the handlers; also guards the bypass-state pushes. */
  canSend: () => boolean;
}

/**
 * Build the host-neutral {@link ProgressBackendUiConfig} (UI callbacks plus the
 * pending-permissions guard) from a set of {@link ApprovalRequestHandler}s.
 *
 * The tool-edit callbacks delegate to their handler, so host differences live
 * entirely in how each handler is constructed (its show/dismiss transport and
 * `canSend` gate) — not in this wiring. The guard checks `hasPendingForStream`
 * across all handlers (see {@link APPROVAL_REQUEST_HANDLER_KEYS}), reusing the
 * handler's empty-streamId-blocks-all rule instead of re-deriving it per host.
 */
export function createProgressBackendUiConfig(
  params: ProgressBackendUiConfigParams,
): ProgressBackendUiConfig {
  const { handlers, webviewUpdater, canSend } = params;
  return {
    callbacks: {
      showToolEditPermission: (p) => handlers.toolEdit.show(p),
      resolveToolEditPermission: (id) => handlers.toolEdit.dismiss(id),
      updateToolEditApprovalBypassState: (streamId, bypassActive) => {
        if (canSend()) {
          webviewUpdater.updateBypassState(streamId, 'toolEdit', bypassActive);
        }
      },
      updateSuperYoloBypassState: (streamId, bypassActive) => {
        if (canSend()) {
          webviewUpdater.updateBypassState(streamId, 'superYolo', bypassActive);
        }
      },
    },
    hasPendingPermissions: (streamId) =>
      APPROVAL_REQUEST_HANDLER_KEYS.some((key) =>
        handlers[key].hasPendingForStream(streamId),
      ),
  };
}
