import type { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import type {
  PresentationDelivery,
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from '@agent/runtime/runtimePresentationEvents';
import {
  cancellationResultFor,
  matchesCancelSelector,
  type BashSettlement,
  type HostApprovalBypassStateUpdate,
  type HostBashApprovalRequest,
  type HostInteractionCancelSelector,
  type HostInteractionOptions,
  type HostInteractions,
  type HostPlanApprovalRequest,
  type HostRetryInteractionOptions,
  type HostRetryRequest,
  type PlanApprovalResult,
  type ProposalResult,
  type RetryResult,
  type RetrySettlement,
  type SettledInteractionKind,
  type UserQuestionSettlement,
} from '@agent/runtime/HostInteractions';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ToolEditApprovalController } from '@controllers/approval/ToolEditApprovalController';
import { warn as logWarning } from '@logger/logUtils';
import type { AgentProposalPermission, StreamTabId } from '@shared/schemas';
import { SESSION_DISPOSED_CAUSE } from '@shared/copy/interactionCancellation';
import { prepareBashApprovalPrompt } from '@tools/approval/bashApproval';
import type {
  ToolEditApprovalRequest,
  ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  cancelApprovalRequestHandlers,
  type ApprovalRequestHandlerSet,
} from './progressBackendUiConfig';

export interface ProgressHostInteractionsOptions {
  interactions: Pick<SessionHostInteractions, 'emit'>;
  session: SessionHandle;
  getApprovalHandlers(): ApprovalRequestHandlerSet;
  getToolEditApprovals(): ToolEditApprovalController;
  setApprovalBypassState(update: HostApprovalBypassStateUpdate): void;
}

/**
 * The progress-view host port: every host that renders approvals in the
 * progress view attaches this to its session, adding only its own extras.
 */
export interface ProgressHostInteractions extends HostInteractions {
  /** Approve work requests that were already pending when stream bypass began. */
  approvePendingDelegatedWork(
    streamId: StreamTabId,
    initiatingProposalId: string,
  ): Promise<void>;
  isRetryPending(streamId: StreamTabId, requestId: string): boolean;
  submitBashDecision(requestId: string, decision: BashSettlement): boolean;
  submitPlanDecision(requestId: string, decision: PlanApprovalResult): boolean;
  submitProposalDecision(requestId: string, decision: ProposalResult): boolean;
  submitRetryDecision(
    streamId: StreamTabId,
    requestId: string,
    decision: RetrySettlement,
  ): boolean;
  /** Settle a retry after switching routing onto the user's own API key. */
  submitRetryWithPersonalCredentials(
    streamId: StreamTabId,
    requestId: string,
    feedback?: string,
  ): Promise<boolean>;
  submitUserQuestionDecision(
    requestId: string,
    decision: UserQuestionSettlement,
  ): boolean;
  dismissExternalInquiry(requestId: string): void;
}

const PROGRESS_INTERACTION_KINDS = [
  'bash',
  'planApproval',
  'proposal',
  'retry',
  'userQuestion',
] as const satisfies readonly SettledInteractionKind[];

export function createProgressHostInteractions(
  options: ProgressHostInteractionsOptions,
): ProgressHostInteractions {
  const handlers = () => options.getApprovalHandlers();

  // Interaction requests surface per-stream: the request panel is scoped to
  // the viewed stream and the requesting stream's row shows a pending badge.
  // `suppressViewSwitch` registers the stream so that row exists without
  // yanking the active tab away from whatever the user is inspecting (#8246).
  const revealStream = (streamId?: StreamTabId | null) => {
    options.interactions.emit('requestEnsureProgressView', {});
    if (streamId) {
      options.session.events.emit({
        scope: 'session',
        event: {
          type: 'setActiveStream',
          payload: {
            streamId,
            suppressViewSwitch: true,
            ensureVisible: true,
          },
        },
      });
    }
  };

  /**
   * The client-preparation callback carried by one pending retry request.
   * Keyed by stream because the shared retry handler only keeps one pending
   * request per stream; the request id guards against a stale settlement.
   */
  interface PendingRetryPreparation {
    readonly requestId: string;
    readonly prepareRetry: NonNullable<
      HostRetryInteractionOptions['prepareRetry']
    >;
    readonly controller: AbortController;
    readonly cancellationScope?: object;
    settling: boolean;
    selection?: 'configured' | 'personal';
    settlement?: Promise<boolean>;
  }
  const retryPreparations = new Map<StreamTabId, PendingRetryPreparation>();

  const isRetryPending = (
    streamId: StreamTabId,
    requestId: string,
  ): boolean => {
    return handlers().retry.get(streamId)?.requestId === requestId;
  };

  const isCurrentRetryPreparation = (
    streamId: StreamTabId,
    requestId: string,
    preparation: PendingRetryPreparation,
  ): boolean =>
    retryPreparations.get(streamId) === preparation &&
    isRetryPending(streamId, requestId);

  /** Whether this exact preparation is still the one stored for the stream. */
  const isStoredRetryPreparation = (
    streamId: StreamTabId,
    preparation: PendingRetryPreparation,
  ): boolean => retryPreparations.get(streamId) === preparation;

  /**
   * Complete one retry settlement without letting a dismiss-delivery failure
   * become an unhandled rejection. `complete` settles the request before it
   * dismisses, so `fallback` reports the settlement the caller already made.
   */
  const completeRetrySettlement = (
    streamId: StreamTabId,
    settlement: RetryResult,
    fallback: boolean,
  ): boolean => {
    try {
      return handlers().retry.complete(streamId, settlement);
    } catch (error) {
      logWarning(
        'progressView',
        `The retry settlement could not be delivered: ${toErrorMessage(error)}`,
      );
      return fallback;
    }
  };

  const settlePreparedRetry = async (
    streamId: StreamTabId,
    requestId: string,
    selection: 'configured' | 'personal',
    feedback?: string,
    denialResult = true,
  ): Promise<boolean> => {
    const preparation = retryPreparations.get(streamId);
    if (!preparation || preparation.requestId !== requestId) {
      // No host-side preparation callback is attached, so the caller's normal
      // retry path (rebind) stays responsible for refreshing the client. When
      // a newer preparation exists, leave it alone: settling it here would
      // resolve a request this caller no longer owns.
      if (preparation) return false;
      return completeRetrySettlement(
        streamId,
        {
          action: 'retry',
          ...(feedback !== undefined ? { feedback } : {}),
        },
        true,
      );
    }
    if (preparation.settling) {
      // A conflicting second selection (plain retry vs. personal-credential
      // switch) cannot adopt the in-flight preparation's result, so reject it
      // instead of pretending it settled.
      if (preparation.selection !== selection) return false;
      return preparation.settlement ?? true;
    }
    preparation.settling = true;
    preparation.selection = selection;
    const settlement = (async (): Promise<boolean> => {
      try {
        await preparation.prepareRetry(
          selection,
          preparation.controller.signal,
        );
      } catch (error) {
        if (!isCurrentRetryPreparation(streamId, requestId, preparation)) {
          // Cancellation may already have removed the pending handler before
          // this abort rejection ran. If the map still stores this exact
          // preparation, remove it so a cancelled stream does not retain the
          // preparation callback and its captured state.
          if (isStoredRetryPreparation(streamId, preparation)) {
            retryPreparations.delete(streamId);
          }
          return false;
        }
        retryPreparations.delete(streamId);
        completeRetrySettlement(
          streamId,
          { action: 'deny', reason: toErrorMessage(error) },
          denialResult,
        );
        // The API-key switch path reports a denied preparation as false so its
        // controller can roll the routing changes back; a plain retry has no
        // routing changes to undo, so it still reports that the request settled.
        return denialResult;
      }
      if (!isCurrentRetryPreparation(streamId, requestId, preparation)) {
        if (isStoredRetryPreparation(streamId, preparation)) {
          retryPreparations.delete(streamId);
        }
        return false;
      }
      retryPreparations.delete(streamId);
      return completeRetrySettlement(
        streamId,
        {
          action: 'retry',
          ...(feedback !== undefined ? { feedback } : {}),
        },
        true,
      );
    })();
    preparation.settlement = settlement;
    return settlement;
  };

  const cancel = (selector: HostInteractionCancelSelector = {}): void => {
    if (selector.kind == null || selector.kind === 'toolEdit') {
      options.getToolEditApprovals().cancel(selector);
    }
    if (selector.kind == null || selector.kind === 'retry') {
      for (const [streamId, preparation] of retryPreparations) {
        if (
          matchesCancelSelector(
            {
              kind: 'retry',
              streamId,
              cancellationScope: preparation.cancellationScope,
            },
            selector,
          )
        ) {
          preparation.controller.abort();
        }
      }
    }
    cancelApprovalRequestHandlers(
      handlers(),
      PROGRESS_INTERACTION_KINDS,
      selector,
    );
  };

  return {
    // Thin pass-through to the caller-supplied presentation dispatcher.
    emit<K extends RuntimePresentationEvent>(
      event: K,
      payload: RuntimePresentationEventPayloads[K],
    ): PresentationDelivery {
      return options.interactions.emit(event, payload);
    },

    setApprovalBypassState: options.setApprovalBypassState,

    async approvePendingDelegatedWork(
      streamId: StreamTabId,
      initiatingProposalId: string,
    ): Promise<void> {
      handlers().bash.completeWhere((item) => item.streamId === streamId, {
        action: 'approve',
      });
      handlers().proposal.completeWhere(
        (item) =>
          item.streamId === streamId &&
          item.proposalId !== initiatingProposalId,
        { action: 'approve' },
      );
      await options.getToolEditApprovals().approvePendingForStream(streamId);
    },

    isRetryPending,

    /**
     * Settle a pending retry request. Returns false when the request is no
     * longer the pending one for that stream, so a stale renderer click cannot
     * resolve a newer request. A retry action runs any forwarded client
     * preparation before the request actually settles; a preparation failure
     * settles the request as a denial instead of retrying with a stale client.
     */
    submitRetryDecision(
      streamId: StreamTabId,
      requestId: string,
      decision: RetrySettlement,
    ): boolean {
      if (!isRetryPending(streamId, requestId)) return false;
      if (decision.action === 'cancel') {
        retryPreparations.get(streamId)?.controller.abort();
        retryPreparations.delete(streamId);
        return completeRetrySettlement(streamId, decision, true);
      }
      void settlePreparedRetry(
        streamId,
        requestId,
        'configured',
        decision.feedback,
      );
      return true;
    },

    /**
     * Settle a retry after the host has switched routing onto the user's own
     * API key. The personal-credential preparation must run before the retry
     * settles; a failure returns false so the API-key controller can roll its
     * routing changes back.
     */
    async submitRetryWithPersonalCredentials(
      streamId: StreamTabId,
      requestId: string,
      feedback?: string,
    ): Promise<boolean> {
      if (!isRetryPending(streamId, requestId)) return false;
      return settlePreparedRetry(
        streamId,
        requestId,
        'personal',
        feedback,
        false,
      );
    },

    submitBashDecision: (requestId, decision) =>
      handlers().bash.complete(requestId, decision),

    submitPlanDecision: (requestId, decision) =>
      handlers().planApproval.complete(requestId, decision),

    submitProposalDecision: (requestId, decision) =>
      handlers().proposal.complete(requestId, decision),

    submitUserQuestionDecision: (requestId, decision) =>
      handlers().userQuestion.complete(requestId, decision),

    dismissExternalInquiry: (requestId) =>
      handlers().externalInquiry.dismiss(requestId),

    requestToolEditApproval(
      request: ToolEditApprovalRequest,
      interactionOptions?: HostInteractionOptions,
    ): Promise<ToolEditApprovalResult> {
      return options
        .getToolEditApprovals()
        .requestApproval(request, interactionOptions);
    },

    requestBashApproval(
      request: HostBashApprovalRequest,
      interactionOptions?: HostInteractionOptions,
    ): Promise<BashSettlement> {
      revealStream(request.streamId);
      return handlers().bash.request(
        prepareBashApprovalPrompt(request, options.session),
        {
          cancellationScope: interactionOptions?.cancellationScope,
          cancellationResult: (cause) => cancellationResultFor('bash', cause),
        },
      );
    },

    requestPlanApproval(
      request: HostPlanApprovalRequest,
      interactionOptions?: HostInteractionOptions,
    ): Promise<PlanApprovalResult> {
      revealStream(request.streamId);
      return handlers().planApproval.request(request, {
        cancellationScope: interactionOptions?.cancellationScope,
        cancellationResult: (cause) =>
          cancellationResultFor('planApproval', cause),
      });
    },

    requestAgentProposal(
      request: AgentProposalPermission,
      interactionOptions?: HostInteractionOptions,
    ): Promise<ProposalResult> {
      revealStream(request.streamId);
      return handlers().proposal.request(request, {
        cancellationScope: interactionOptions?.cancellationScope,
        cancellationResult: (cause) => cancellationResultFor('proposal', cause),
      });
    },

    /**
     * Surface a retryable model failure to the user instead of auto-cancelling
     * it: reveal the stream and park the request on the shared `retry` handler,
     * whose card the progress view already renders (`RetryRequestPanel`). The
     * renderer settles it through `submitRetryDecision` or a cancel decision.
     */
    requestRetry(
      request: HostRetryRequest,
      interactionOptions?: HostRetryInteractionOptions,
    ): Promise<RetryResult> {
      revealStream(request.streamId);
      // A replacement retry on the same stream cancels any preparation still
      // in flight for the request it replaces; the shared handler does the same
      // for its pending entry below.
      retryPreparations.get(request.streamId)?.controller.abort();
      if (interactionOptions?.prepareRetry) {
        retryPreparations.set(request.streamId, {
          requestId: request.requestId,
          prepareRetry: interactionOptions.prepareRetry,
          controller: new AbortController(),
          cancellationScope: interactionOptions.cancellationScope,
          settling: false,
        });
      } else {
        retryPreparations.delete(request.streamId);
      }
      return handlers().retry.request(request, {
        cancellationScope: interactionOptions?.cancellationScope,
        cancellationResult: (cause) => cancellationResultFor('retry', cause),
      });
    },

    askUserQuestion(
      request: Parameters<NonNullable<HostInteractions['askUserQuestion']>>[0],
      interactionOptions?: HostInteractionOptions,
    ): Promise<UserQuestionSettlement> {
      revealStream(request.streamId || undefined);
      return handlers().userQuestion.request(request, {
        cancellationScope: interactionOptions?.cancellationScope,
        cancellationResult: (cause) =>
          cancellationResultFor('userQuestion', cause),
      });
    },

    async openExternalInquiry(request) {
      revealStream(request.streamId || undefined);
      handlers().externalInquiry.show(request);
      return { threadId: request.threadId };
    },

    cancel,

    dispose(): void {
      cancel({ cause: SESSION_DISPOSED_CAUSE });
      retryPreparations.clear();
    },
  };
}
