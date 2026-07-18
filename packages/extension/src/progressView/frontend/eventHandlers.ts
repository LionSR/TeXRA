import { create } from 'mutative';

// Local imports - shared webview
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import {
  type GettingStartedActionDetail,
  type ProgressViewInboundMessage,
  type StreamTabId,
} from '@shared/schemas';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';

// Local imports - progress view
import { firstStreamId, isToolUseState } from './store';
import { deleteFollowUpInputTransientState } from './followUpInputState';
import { addResolvedProposalId, removePrompt } from './slices/permissionSlice';
import { updateToolUseState } from './stateUtils';
import { clearInquiryDraft } from './components/ExternalInquiryPanel';
import {
  APPROVE_SESSION_ACTION,
  APPROVE_ALL_DELEGATED_WORK_ACTION,
  type FilterEventDetail,
  type FollowUpClearDetail,
  type FollowupCommandDetail,
  type FollowUpChangeDetail,
  type FollowUpSendDetail,
  type PermissionActionDetail,
  type ProgressFileActionDetail,
  type StreamEventDetail,
  type ToolbarCommandDetail,
} from './events';
import {
  appState,
  permissions$,
  placement,
  setStreamLogsForId,
  setStreamStateForId,
} from './progressState';
import type {
  FrontendEventHandlerContext,
  MessageHandlerContext,
} from './messageHandlerTypes';

/**
 * Handler contexts for a host with no live filter-persistence backend
 * (desktop, trace-viewer) — unlike `ProgressApp`'s own versions, which wire
 * `savePrefs` to its VS Code webview-specific `prefsManager`. Shared here so
 * neither host hand-copies the same getters/setters over `progressState`'s
 * signals.
 */
export function createHostEventHandlerContext(): FrontendEventHandlerContext {
  return {
    getState: () => appState.get(),
    setState: (updater) => appState.set(updater(appState.get())),
    setStreamState: setStreamStateForId,
    setStreamLogs: setStreamLogsForId,
  };
}

export function createHostMessageHandlerContext(): MessageHandlerContext {
  return {
    ...createHostEventHandlerContext(),
    getPermissions: () => permissions$.get(),
    setPermissions: (next) => {
      permissions$.set(next);
    },
    setPlacement: (next) => {
      placement.set(next);
    },
  };
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
  deleteFollowUpInputTransientState(streamId);

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

export function handleGettingStartedAction(
  event: CustomEvent<GettingStartedActionDetail>,
): void {
  postMessage(PROGRESS_VIEW_COMMANDS.GETTING_STARTED_ACTION, {
    action: event.detail.action,
  });
}

export function handleFollowUpChange(
  event: CustomEvent<FollowUpChangeDetail>,
  ctx: FrontendEventHandlerContext,
): void {
  const { mode = 'replace', streamId, value } = event.detail;
  if (!ctx.getState().streamStates.has(streamId)) return;
  updateToolUseState(ctx, streamId, (prev) =>
    create(prev, (draft) => {
      if (mode === 'replace') {
        draft.ui.followUpText = value;
        return;
      }
      if (!value) return;
      const current = prev.ui.followUpText ?? '';
      const separator =
        current && !/\s$/.test(current) && !/^\s/.test(value) ? ' ' : '';
      draft.ui.followUpText = `${current}${separator}${value}`;
    }),
  );
}

/** Resolve one tool-use stream's trimmed follow-up text, or null if unavailable. */
function getFollowUpText(
  ctx: FrontendEventHandlerContext,
  streamId: StreamTabId,
): { streamId: StreamTabId; text: string } | null {
  const state = ctx.getState();
  const streamState = state.streamStates.get(streamId);
  if (!streamState || !isToolUseState(streamState)) return null;

  const text = streamState.ui.followUpText?.trim() ?? '';
  if (!text) return null;

  return { streamId, text };
}

export function handleFollowUpSend(
  event: CustomEvent<FollowUpSendDetail>,
  ctx: FrontendEventHandlerContext,
): void {
  const result = getFollowUpText(ctx, event.detail.streamId);
  if (!result) return;

  // Orphan gate: only attach images whose [fileName] token survives in the
  // submitted text (the user may have deleted a pasted chip before sending).
  const attached = event.detail.images.filter((img) =>
    result.text.includes(`[${img.fileName}]`),
  );

  postMessage(PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP, {
    stream: result.streamId,
    text: result.text,
    ...(attached.length > 0 ? { images: attached } : {}),
  });
  updateToolUseState(ctx, result.streamId, (prev) =>
    create(prev, (draft) => {
      draft.ui.followUpText = '';
    }),
  );
}

export function handleFollowUpPolish(ctx: FrontendEventHandlerContext): void {
  const streamId = ctx.getState().activeStreamId;
  const result = streamId ? getFollowUpText(ctx, streamId) : null;
  if (!result) return;

  postMessage(PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP, {
    stream: result.streamId,
    text: result.text,
  });
}

export function handleFollowUpClear(
  event: CustomEvent<FollowUpClearDetail>,
  ctx: FrontendEventHandlerContext,
): void {
  const streamId = event.detail.streamId;
  if (!ctx.getState().streamStates.has(streamId)) return;
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

/**
 * Post an optional session-bypass-enable message before the terminal
 * protocol message it gates. Webview messages are delivered FIFO to the
 * extension host, and the bypass-enable message sets the per-stream bypass
 * synchronously when handled — so sending it first guarantees it lands
 * before the terminal message unblocks the agent, and the agent can't race
 * ahead and re-prompt the next gated action before bypass is live.
 */
function postWithOptionalBypass(
  bypassMessage: ProgressViewInboundMessage | undefined,
  message: ProgressViewInboundMessage,
): void {
  if (bypassMessage) {
    postPermissionMessage(bypassMessage);
  }
  postPermissionMessage(message);
}

export function handlePermissionAction(
  event: CustomEvent<PermissionActionDetail>,
  ctx: MessageHandlerContext,
): void {
  const detail = event.detail;

  switch (detail.kind) {
    case PERMISSION_KIND.TOOL_EDIT: {
      const { data, decision } = detail;
      // "Yolo (this session)" approves the current request like a normal
      // approve and enables auto-approval (edits + bash) for the rest of the
      // stream — mirroring the toolbar shield and the CLI's `a` = approve
      // session. It never reaches the backend approval protocol.
      const isYolo = decision.action === APPROVE_SESSION_ACTION;
      // Set-on (not toggle) is inversion-proof: edit and bash bypass can be
      // decoupled on a delegated child stream. The button only renders with
      // a real stream (see canBypass), but guard anyway.
      const bypassMessage =
        isYolo && data.streamId
          ? ({
              command: PROGRESS_VIEW_COMMANDS.ENABLE_APPROVAL_BYPASS,
              stream: data.streamId,
            } satisfies ProgressViewInboundMessage)
          : undefined;
      const action = isYolo ? 'approve' : decision.action;
      postWithOptionalBypass(
        bypassMessage,
        decision.action === 'reject'
          ? {
              command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
              requestId: data.requestId,
              action,
              ...(decision.feedback ? { feedback: decision.feedback } : {}),
            }
          : {
              command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
              requestId: data.requestId,
              action,
            },
      );
      // Only remove for terminal actions (approve/reject/approveSession).
      // Non-terminal actions like openDiff, previewProposed, showLatexdiff
      // just open editors without settling the approval.
      if (action === 'approve' || action === 'reject') {
        removePrompt(ctx, detail.kind, data.requestId);
      }
      break;
    }
    case PERMISSION_KIND.BASH: {
      const { data, decision } = detail;
      const isYolo = decision.action === APPROVE_SESSION_ACTION;
      const bypassMessage =
        isYolo && data.streamId
          ? ({
              command: PROGRESS_VIEW_COMMANDS.ENABLE_APPROVAL_BYPASS,
              stream: data.streamId,
            } satisfies ProgressViewInboundMessage)
          : undefined;
      postWithOptionalBypass(
        bypassMessage,
        decision.action === 'reject'
          ? {
              command: PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION,
              requestId: data.requestId,
              action: decision.action,
              ...(decision.feedback ? { feedback: decision.feedback } : {}),
            }
          : {
              command: PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION,
              requestId: data.requestId,
              action: 'approve',
            },
      );
      removePrompt(ctx, detail.kind, data.requestId);
      break;
    }
    case PERMISSION_KIND.RETRY: {
      const { data, decision } = detail;
      if (decision.action === 'useOwnApiKey') {
        // Non-terminal: panel stays open. The extension handler will
        // trigger retry on success, or leave the panel for the user
        // to choose Retry/Dismiss if the user cancels the key picker.
        const exhaustionReason = data.errorDetails?.exhaustionReason;
        postMessage(PROGRESS_VIEW_COMMANDS.USE_OWN_API_KEY, {
          stream: data.streamId,
          requestId: data.requestId,
          model: data.model,
          exhaustionReason,
          // Subscription quota exhaustion always means the OpenAI key is the
          // fallback credential, regardless of how the error tagged provider.
          provider:
            exhaustionReason === 'chatgpt-subscription'
              ? 'openai'
              : data.errorDetails?.provider,
          viaRelay: data.errorDetails?.isRelayError === true ? true : undefined,
        });
        break;
      }
      if (decision.action === 'retry') {
        postMessage(PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST, {
          stream: data.streamId,
          requestId: data.requestId,
        });
      } else {
        postMessage(PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST, {
          stream: data.streamId,
          requestId: data.requestId,
        });
      }
      // Optimistic removal
      removePrompt(ctx, PERMISSION_KIND.RETRY, data.streamId);
      break;
    }
    case PERMISSION_KIND.PROPOSAL: {
      const { data, decision } = detail;
      // Approve-all accepts this proposal and enables delegated-task approval
      // for the rest of the stream. It never reaches the backend proposal
      // protocol (action stays approve|reject|setup). Use the idempotent
      // ENABLE (force-on), not the TOGGLE: approval can be turned on from the
      // stream header while this prompt is still visible (which does not
      // auto-resolve the open proposal), and a toggle would then flip bypass
      // back OFF here — the opposite of "enable". Mirrors edit/bash
      // ENABLE_APPROVAL_BYPASS (see postWithOptionalBypass for the FIFO
      // ordering rationale shared by all three bypass-gated permission kinds).
      const approveAllDelegatedWork =
        decision.action === APPROVE_ALL_DELEGATED_WORK_ACTION;
      const bypassMessage = approveAllDelegatedWork
        ? ({
            command: PROGRESS_VIEW_COMMANDS.ENABLE_SUPER_YOLO_BYPASS,
            stream: data.streamId,
            initiatingProposalId: data.proposalId,
          } satisfies ProgressViewInboundMessage)
        : undefined;
      let message: ProgressViewInboundMessage;
      if (decision.action === 'approve' || approveAllDelegatedWork) {
        message = {
          command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
          proposalId: data.proposalId,
          action: 'approve',
          ...(decision.model ? { model: decision.model } : {}),
          ...(decision.agent ? { agent: decision.agent } : {}),
        };
      } else if (decision.action === 'reject') {
        message = {
          command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
          proposalId: data.proposalId,
          action: 'reject',
          ...(decision.feedback ? { feedback: decision.feedback } : {}),
        };
      } else {
        message = {
          command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
          proposalId: data.proposalId,
          action: 'setup',
        };
      }
      postWithOptionalBypass(bypassMessage, message);
      // Optimistic removal — track resolved ID so late SHOW is a no-op
      const removed = removePrompt(
        ctx,
        PERMISSION_KIND.PROPOSAL,
        data.proposalId,
      );
      if (!removed) {
        addResolvedProposalId(data.proposalId);
      }
      break;
    }
    case PERMISSION_KIND.PLAN_APPROVAL: {
      const { data, decision } = detail;
      postPermissionMessage(
        decision.action === 'reject'
          ? {
              command: PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION,
              approvalId: data.approvalId,
              action: decision.action,
              ...(decision.feedback ? { feedback: decision.feedback } : {}),
            }
          : {
              command: PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION,
              approvalId: data.approvalId,
              action: decision.action,
            },
      );
      removePrompt(ctx, PERMISSION_KIND.PLAN_APPROVAL, data.approvalId);
      break;
    }
    case PERMISSION_KIND.EXTERNAL_INQUIRY: {
      const { data, decision } = detail;
      if (decision.action === 'submit') {
        postPermissionMessage({
          command: PROGRESS_VIEW_COMMANDS.EXTERNAL_INQUIRY_ACTION,
          action: 'submit',
          threadId: data.threadId,
          answer: decision.answer,
          ...(decision.sessionLinks
            ? { sessionLinks: decision.sessionLinks }
            : {}),
        });
      } else {
        postPermissionMessage({
          command: PROGRESS_VIEW_COMMANDS.EXTERNAL_INQUIRY_ACTION,
          action: 'drop',
          threadId: data.threadId,
          ...(decision.feedback ? { feedback: decision.feedback } : {}),
        });
      }
      removePrompt(ctx, PERMISSION_KIND.EXTERNAL_INQUIRY, data.requestId);
      clearInquiryDraft(data.requestId);
      break;
    }
    case PERMISSION_KIND.USER_QUESTION: {
      const { data, decision } = detail;
      postPermissionMessage({
        command: PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION,
        requestId: data.requestId,
        ...decision,
      });
      removePrompt(ctx, PERMISSION_KIND.USER_QUESTION, data.requestId);
      break;
    }
  }
}

function postPermissionMessage(message: ProgressViewInboundMessage): void {
  const { command, ...payload } = message;
  postMessage(command, payload);
}
