import type { AgentTrace } from '@agent/trace';
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
import type { ProgressBackendUiConfig } from './ProgressBackend';
import type { WebviewUpdater } from './WebviewUpdater';

/**
 * The seven pending-approval handlers a progress backend wires. Hosts build
 * each handler with their own show/resolve transport (and `canSend` gate), then
 * hand the set to {@link createProgressBackendUiConfig}, which derives the
 * uniform UI callbacks and the pending-permissions guard from them.
 */
export interface ApprovalRequestHandlerSet {
  toolEdit: ApprovalRequestHandler<ToolEditPermission, 'requestId'>;
  bash: ApprovalRequestHandler<BashPermission, 'requestId'>;
  retry: ApprovalRequestHandler<RetryPermission, 'streamId'>;
  agentProposal: ApprovalRequestHandler<AgentProposalPermission, 'proposalId'>;
  planApproval: ApprovalRequestHandler<PlanApprovalPermission, 'approvalId'>;
  externalInquiry: ApprovalRequestHandler<
    ExternalInquiryPermission,
    'requestId'
  >;
  userQuestion: ApprovalRequestHandler<UserQuestionPermission, 'requestId'>;
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
 * Host-specific show/resolve transport for one approval kind. retry and
 * agentProposal differ across hosts (the extension shows a retry panel and
 * upgrades proposals with model/agent dropdowns; the desktop cancels retries
 * and shows a plain proposal), so each host supplies these two directly.
 */
interface ApprovalHandlerTransport<T> {
  show: (item: T) => void;
  resolve: (id: string) => void;
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
>(
  webviewUpdater: WebviewUpdater,
  canSend: () => boolean,
  kind: K,
  idField: IdField,
): ApprovalRequestHandler<PermissionData<K>, IdField> {
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
    bash: webviewPermissionHandler(
      webviewUpdater,
      canSend,
      PERMISSION_KIND.BASH,
      'requestId',
    ),
    planApproval: webviewPermissionHandler(
      webviewUpdater,
      canSend,
      PERMISSION_KIND.PLAN_APPROVAL,
      'approvalId',
    ),
    externalInquiry: new ExternalInquiryRequestHandler({
      show: (data) =>
        webviewUpdater.showPermission({
          kind: PERMISSION_KIND.EXTERNAL_INQUIRY,
          data,
        }),
      resolve: (id) =>
        webviewUpdater.resolvePermission(PERMISSION_KIND.EXTERNAL_INQUIRY, id),
      syncThreads: (threads) => webviewUpdater.syncInquiryThreads(threads),
      canSend,
      logger: params.logger,
    }),
    userQuestion: webviewPermissionHandler(
      webviewUpdater,
      canSend,
      PERMISSION_KIND.USER_QUESTION,
      'requestId',
    ),
    retry: new ApprovalRequestHandler<RetryPermission, 'streamId'>(
      'streamId',
      overrides.retry.show,
      overrides.retry.resolve,
      canSend,
    ),
    agentProposal: new ApprovalRequestHandler<
      AgentProposalPermission,
      'proposalId'
    >(
      'proposalId',
      overrides.agentProposal.show,
      overrides.agentProposal.resolve,
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
 * entirely in how each handler is constructed (its show/resolve transport and
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
      resolveToolEditPermission: (id) => handlers.toolEdit.resolve(id),
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
