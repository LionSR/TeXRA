import { create } from 'mutative';

// Local imports - shared webview
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import { postMessage } from '@shared/hostBridge';
import type { StreamTabId } from '@shared/schemas';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';

// Local imports - progress view
import {
  firstStreamId,
  getStreamState,
  isToolUseState,
  type ProgressState,
  type StreamFilter,
  type StreamLogs,
  type StreamState,
} from './store';
import { removePrompt, resolvedProposalIds } from './slices/permissionSlice';
import { updateToolUseState } from './stateUtils';
import { clearInquiryDraft } from './components/ExternalInquiryPanel';
import type {
  FilterEventDetail,
  FollowupCommandDetail,
  FollowUpChangeDetail,
  PermissionActionDetail,
  ProgressFileActionDetail,
  StreamEventDetail,
  ToolbarCommandDetail,
} from './events';
import type { MessageHandlerContext } from './messageDispatcher';

/**
 * Context passed to frontend event handlers providing access to state and refs.
 *
 * Note: Named "FrontendEventHandlerContext" to distinguish from the backend
 * EventHandlerContext in src/progressView/events/EventHandlerContext.ts which
 * has different shape (state manager + webview updater vs getters/setters).
 */
export interface FrontendEventHandlerContext {
  getState(): ProgressState;
  setState(updater: (prev: ProgressState) => ProgressState): void;
  setStreamState(
    streamId: StreamTabId,
    updater: (prev: StreamState) => StreamState,
  ): void;
  setStreamLogs(
    streamId: StreamTabId,
    updater: (prev: StreamLogs) => StreamLogs,
  ): void;
  /** Persist filter preference to webview state. */
  savePrefs?(prefs: Partial<{ streamFilter: StreamFilter }>): void;
}

export function handleStreamSwitch(
  event: CustomEvent<StreamEventDetail>,
  ctx: FrontendEventHandlerContext,
): void {
  const streamId = event.detail.streamId;
  // Optimistic: highlight tab immediately
  ctx.setState((prev) =>
    create(prev, (draft) => {
      draft.activeStreamId = streamId;
    }),
  );
  postMessage(PROGRESS_VIEW_COMMANDS.SWITCH_STREAM, { stream: streamId });
}

export function handleStreamDelete(
  event: CustomEvent<StreamEventDetail>,
  ctx: FrontendEventHandlerContext,
): void {
  const streamId = event.detail.streamId;

  // Optimistic removal: apply delete locally before notifying backend
  ctx.setState((prev) =>
    create(prev, (draft) => {
      draft.streamStates.delete(streamId);
      draft.streamLogs.delete(streamId);
      draft.processOutputs.delete(streamId);
      draft.followupOptionsByStream.delete(streamId);
      draft.streamById.delete(streamId);
      if (draft.activeStreamId === streamId) {
        draft.activeStreamId = firstStreamId(draft.streamById);
      }
    }),
  );

  // Fire-and-forget to backend
  postMessage(PROGRESS_VIEW_COMMANDS.DELETE_STREAM, { stream: streamId });
}

export function handleFilterChange(
  event: CustomEvent<FilterEventDetail>,
  ctx: FrontendEventHandlerContext,
): void {
  const { filter } = event.detail;
  ctx.setState((prev) =>
    create(prev, (draft) => {
      draft.streamFilter = filter;
    }),
  );
  ctx.savePrefs?.({ streamFilter: filter });
  postMessage(PROGRESS_VIEW_COMMANDS.FILTER_STREAMS, { filter });
}

export function handleDeleteAll(): void {
  postMessage(PROGRESS_VIEW_COMMANDS.DELETE_ALL, {});
}

export function handleToolbarCommand(
  event: CustomEvent<ToolbarCommandDetail>,
  ctx: FrontendEventHandlerContext,
): void {
  const { command } = event.detail;
  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;
  postMessage(command, { stream: streamId });
}

export function handleFileAction(
  event: CustomEvent<ProgressFileActionDetail>,
): void {
  const { command, file, base, prev } = event.detail;
  postMessage(command, {
    file,
    ...(base && { base }),
    ...(prev && { prev }),
  });
}

export function handleFollowUpChange(
  event: CustomEvent<FollowUpChangeDetail>,
  ctx: FrontendEventHandlerContext,
): void {
  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;
  updateToolUseState(ctx, streamId, (prev) =>
    create(prev, (draft) => {
      draft.ui.followUpText = event.detail.value;
    }),
  );
}

/** Resolve the active tool-use stream's trimmed follow-up text, or null if unavailable. */
function getActiveFollowUpText(
  ctx: FrontendEventHandlerContext,
): { streamId: StreamTabId; text: string } | null {
  const state = ctx.getState();
  const streamId = state.activeStreamId;
  if (!streamId) return null;

  const streamInfo = state.streamById.get(streamId);
  const streamState = getStreamState(
    state,
    streamId,
    streamInfo?.agentCategory,
  );
  if (!isToolUseState(streamState)) return null;

  const text = streamState.ui.followUpText?.trim() ?? '';
  if (!text) return null;

  return { streamId, text };
}

export function handleFollowUpSend(ctx: FrontendEventHandlerContext): void {
  const result = getActiveFollowUpText(ctx);
  if (!result) return;

  postMessage(PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP, {
    stream: result.streamId,
    text: result.text,
  });
  updateToolUseState(ctx, result.streamId, (prev) =>
    create(prev, (draft) => {
      draft.ui.followUpText = '';
    }),
  );
}

export function handleFollowUpPolish(ctx: FrontendEventHandlerContext): void {
  const result = getActiveFollowUpText(ctx);
  if (!result) return;

  postMessage(PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP, {
    stream: result.streamId,
    text: result.text,
  });
}

export function handleFollowUpClear(ctx: FrontendEventHandlerContext): void {
  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;
  updateToolUseState(ctx, streamId, (prev) =>
    create(prev, (draft) => {
      draft.ui.followUpText = '';
    }),
  );
}

export function runCompileFixer(ctx: FrontendEventHandlerContext): void {
  const stream = ctx.getState().activeStreamId;
  if (!stream) return;
  postMessage(PROGRESS_VIEW_COMMANDS.RUN_COMPILE_FIXER, { stream });
}

export function handleFollowupRequestOptions(
  ctx: FrontendEventHandlerContext,
): void {
  const stream = ctx.getState().activeStreamId;
  if (!stream) return;
  postMessage(PROGRESS_VIEW_COMMANDS.GET_FOLLOWUP_OPTIONS, { stream });
}

export function sendFollowupCommand(
  command:
    | typeof PROGRESS_VIEW_COMMANDS.SETUP_FOLLOWUP
    | typeof PROGRESS_VIEW_COMMANDS.RUN_FOLLOWUP,
  event: CustomEvent<FollowupCommandDetail>,
  ctx: FrontendEventHandlerContext,
): void {
  const stream = ctx.getState().activeStreamId;
  if (!stream) return;
  const { agent, model, initialQuestion } = event.detail;
  postMessage(command, {
    stream,
    agent,
    model,
    initialQuestion,
  });
}

export function handlePermissionAction(
  event: CustomEvent<PermissionActionDetail>,
  ctx: MessageHandlerContext,
): void {
  const { permission, action, feedback, modelOverride, agentOverride, answer } =
    event.detail;
  const { answers, sessionLinks } = event.detail;

  switch (permission.kind) {
    case PERMISSION_KIND.TOOL_EDIT:
    case PERMISSION_KIND.BASH: {
      const command =
        permission.kind === PERMISSION_KIND.TOOL_EDIT
          ? PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION
          : PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION;
      postMessage(command, {
        requestId: permission.data.requestId,
        action,
        feedback,
      });
      // Only remove for terminal actions (approve/reject).
      // Non-terminal actions like openDiff, previewProposed, showLatexdiff
      // just open editors without settling the approval.
      if (action === 'approve' || action === 'reject') {
        removePrompt(
          ctx,
          permission.kind,
          'requestId',
          permission.data.requestId,
        );
      }
      break;
    }
    case PERMISSION_KIND.RETRY:
      if (action === 'useOwnApiKey') {
        // Non-terminal: panel stays open. The extension handler will
        // trigger retry on success, or leave the panel for the user
        // to choose Retry/Dismiss if the user cancels the key picker.
        postMessage(PROGRESS_VIEW_COMMANDS.USE_OWN_API_KEY, {
          stream: permission.data.streamId,
          provider: permission.data.errorDetails?.provider,
          upstreamCreditDepleted:
            permission.data.errorDetails?.isUpstreamCreditDepleted === true
              ? true
              : undefined,
          viaRelay:
            permission.data.errorDetails?.isRelayError === true
              ? true
              : undefined,
        });
        break;
      }
      if (action === 'retry') {
        postMessage(PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST, {
          stream: permission.data.streamId,
          feedback,
        });
      } else {
        postMessage(PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST, {
          stream: permission.data.streamId,
        });
      }
      // Optimistic removal
      removePrompt(
        ctx,
        PERMISSION_KIND.RETRY,
        'streamId',
        permission.data.streamId,
      );
      break;
    case PERMISSION_KIND.PROPOSAL:
      postMessage(PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION, {
        proposalId: permission.data.proposalId,
        action,
        feedback,
        model: modelOverride,
        agent: agentOverride,
      });
      // Optimistic removal — track resolved ID so late SHOW is a no-op
      const removed = removePrompt(
        ctx,
        PERMISSION_KIND.PROPOSAL,
        'proposalId',
        permission.data.proposalId,
      );
      if (!removed) {
        resolvedProposalIds.add(permission.data.proposalId);
      }
      break;
    case PERMISSION_KIND.PLAN_APPROVAL:
      postMessage(PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION, {
        approvalId: permission.data.approvalId,
        action,
        feedback,
      });
      removePrompt(
        ctx,
        PERMISSION_KIND.PLAN_APPROVAL,
        'approvalId',
        permission.data.approvalId,
      );
      break;
    case PERMISSION_KIND.EXTERNAL_INQUIRY: {
      const { requestId } = permission.data;
      postMessage(PROGRESS_VIEW_COMMANDS.EXTERNAL_INQUIRY_ACTION, {
        requestId,
        action,
        feedback,
        answer,
        sessionLinks,
      });
      removePrompt(
        ctx,
        PERMISSION_KIND.EXTERNAL_INQUIRY,
        'requestId',
        requestId,
      );
      clearInquiryDraft(requestId);
      break;
    }
    case PERMISSION_KIND.USER_QUESTION: {
      const { requestId } = permission.data;
      postMessage(PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION, {
        requestId,
        action,
        feedback,
        answers,
      });
      removePrompt(ctx, PERMISSION_KIND.USER_QUESTION, 'requestId', requestId);
      break;
    }
  }
}
