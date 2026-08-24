import { create } from 'mutative';

// Local imports - shared webview
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import {
  type GettingStartedActionDetail,
  type ProgressViewInboundMessage,
  type StreamTabId,
  type ToolUseStreamState,
} from '@shared/schemas';
import { userFollowUpAvailability } from '@shared/streams/followUpCapability';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';

// Local imports - progress view
import {
  deleteStreamState,
  detachChildStreamTabs,
  firstStreamId,
  isToolUseState,
} from './store';
import {
  deleteFollowUpInputTransientState,
  followUpAttachmentFingerprintsMatch,
  followUpAttachmentSnapshot,
} from './followUpInputState';
import {
  deletePersistedFollowUpDraft,
  persistFollowUpDraft,
} from './followUpDraftPersistence';
import { addResolvedProposalId, removePrompt } from './slices/permissionSlice';
import { updateToolUseState } from './stateUtils';
import { clearInquiryDraft } from './components/ExternalInquiryPanel';
import {
  APPROVE_SESSION_ACTION,
  APPROVE_ALL_DELEGATED_WORK_ACTION,
  type FollowupCommandDetail,
  type FollowUpChangeDetail,
  type FollowUpSendDetail,
  type PermissionActionDetail,
  type ProgressFileActionDetail,
  type StreamEventDetail,
  type ToolbarCommandDetail,
} from './events';
import { appState, setStreamStateForId } from './progressState';

export function handleStreamSwitch(
  event: CustomEvent<StreamEventDetail>,
): void {
  const streamId = event.detail.streamId;
  // Optimistic: highlight tab immediately
  appState.set(
    create(appState.get(), (draft) => {
      draft.activeStreamId = streamId;
    }),
  );
  postMessage(PROGRESS_VIEW_COMMANDS.SWITCH_STREAM, { stream: streamId });
}

export function handleStreamDelete(
  event: CustomEvent<StreamEventDetail>,
): void {
  const streamId = event.detail.streamId;
  deleteFollowUpInputTransientState(streamId);
  deletePersistedFollowUpDraft(streamId);

  // Optimistic removal: apply delete locally before notifying backend
  appState.set(
    create(appState.get(), (draft) => {
      deleteStreamState(draft, streamId);
      draft.streamById.delete(streamId);
      detachChildStreamTabs(draft, streamId);
      if (draft.activeStreamId === streamId) {
        draft.activeStreamId = firstStreamId(draft.streamById);
      }
    }),
  );

  // Fire-and-forget to backend
  postMessage(PROGRESS_VIEW_COMMANDS.DELETE_STREAM, { stream: streamId });
}

export function handleToolbarCommand(
  event: CustomEvent<ToolbarCommandDetail>,
): void {
  const { command } = event.detail;
  const streamId = appState.get().activeStreamId;
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
): void {
  const { mode = 'replace', streamId, value } = event.detail;
  if (!appState.get().streamStates.has(streamId)) return;
  updateToolUseState(streamId, (prev) =>
    create(prev, (draft) => {
      if (mode === 'replace') {
        draft.ui.followUpText = value;
        if (
          draft.ui.followUpSubmission?.status === 'failed' &&
          draft.ui.followUpSubmission.text !== value.trim()
        ) {
          draft.ui.followUpSubmission = null;
        }
        return;
      }
      if (!value) return;
      const current = prev.ui.followUpText ?? '';
      const separator =
        current && !/\s$/.test(current) && !/^\s/.test(value) ? ' ' : '';
      draft.ui.followUpText = `${current}${separator}${value}`;
    }),
  );
  persistFollowUpDraft(streamId);
}

/** Resolve one tool-use stream's trimmed follow-up text, or null if unavailable. */
function getFollowUpText(streamId: StreamTabId): {
  streamState: ToolUseStreamState;
  text: string;
} | null {
  const streamState = appState.get().streamStates.get(streamId);
  if (!streamState || !isToolUseState(streamState)) return null;

  const text = streamState.ui.followUpText.trim();
  return text ? { streamState, text } : null;
}

export function handleFollowUpSend(
  event: CustomEvent<FollowUpSendDetail>,
): void {
  const { streamId } = event.detail;
  const result = getFollowUpText(streamId);
  if (!result) return;

  if (result.streamState.ui.followUpSubmission?.status === 'sending') return;

  // Orphan gate: only attach images whose [fileName] token survives in the
  // submitted text (the user may have deleted a pasted chip before sending).
  const { images: attached, fingerprints: attachmentFingerprints } =
    followUpAttachmentSnapshot(result.text, event.detail.images);
  const previousSubmission = result.streamState.ui.followUpSubmission;
  const reuseDelivery =
    previousSubmission?.status === 'failed' &&
    previousSubmission.text === result.text &&
    followUpAttachmentFingerprintsMatch(
      previousSubmission.attachmentFingerprints,
      attachmentFingerprints,
    );
  const deliveryId = reuseDelivery
    ? previousSubmission.deliveryId
    : globalThis.crypto.randomUUID();
  const availability = userFollowUpAvailability(result.streamState);
  if (!availability.available) {
    updateToolUseState(streamId, (prev) =>
      create(prev, (draft) => {
        draft.ui.followUpSubmission = {
          status: 'failed',
          deliveryId,
          text: result.text,
          attachmentFingerprints,
          error: availability.message,
        };
      }),
    );
    persistFollowUpDraft(streamId);
    return;
  }

  updateToolUseState(streamId, (prev) =>
    create(prev, (draft) => {
      draft.ui.followUpSubmission = {
        status: 'sending',
        deliveryId,
        text: result.text,
        attachmentFingerprints,
      };
    }),
  );
  const persistence = persistFollowUpDraft(streamId);
  if (!persistence.persisted) {
    updateToolUseState(streamId, (prev) =>
      create(prev, (draft) => {
        draft.ui.followUpSubmission = {
          ...draft.ui.followUpSubmission!,
          status: 'failed',
          error: persistence.error,
        };
      }),
    );
    persistFollowUpDraft(streamId);
    return;
  }
  postMessage(PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP, {
    stream: streamId,
    text: result.text,
    deliveryId,
    ...(attached.length > 0 ? { images: attached } : {}),
  });
}

export function handleFollowUpPolish(): void {
  const streamId = appState.get().activeStreamId;
  const result = streamId ? getFollowUpText(streamId) : null;
  if (!result) return;

  postMessage(PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP, {
    stream: streamId,
    text: result.text,
  });
}

/**
 * Reset focus/polish/transcription triggers after they've been consumed
 * (`followup-focus-complete`). Shared by every host that mounts
 * `<stream-conversation>`.
 */
export function handleFollowUpFocusComplete(): void {
  const streamId = appState.get().activeStreamId;
  if (!streamId) return;

  setStreamStateForId(streamId, (prev) => {
    if (!isToolUseState(prev)) return prev;
    return create(prev, (draft) => {
      draft.ui.shouldFocusFollowUp = false;
      draft.ui.polishedText = null;
      draft.ui.transcribedText = null;
    });
  });
}

export function runCompileFixer(): void {
  const stream = appState.get().activeStreamId;
  if (!stream) return;
  postMessage(PROGRESS_VIEW_COMMANDS.RUN_COMPILE_FIXER, { stream });
}

export function handleFollowupRequestOptions(): void {
  const stream = appState.get().activeStreamId;
  if (!stream) return;
  postMessage(PROGRESS_VIEW_COMMANDS.GET_FOLLOWUP_OPTIONS, { stream });
}

export function sendFollowupCommand(
  command:
    | typeof PROGRESS_VIEW_COMMANDS.SETUP_FOLLOWUP
    | typeof PROGRESS_VIEW_COMMANDS.RUN_FOLLOWUP,
  event: CustomEvent<FollowupCommandDetail>,
): void {
  const stream = appState.get().activeStreamId;
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

/**
 * Build the session-bypass enable that accompanies the broader approve action.
 * The grant covers only the prompt's own kind, so an edit prompt never
 * auto-approves shell commands. Set-on (not toggle) is inversion-proof: a
 * stream can already carry that kind's bypass from the shield or from
 * delegated inheritance. The button only renders with a real stream (see
 * canBypass), but guard anyway.
 */
function approvalBypassMessage(
  streamId: string | undefined,
  kind: typeof PERMISSION_KIND.TOOL_EDIT | typeof PERMISSION_KIND.BASH,
): ProgressViewInboundMessage | undefined {
  if (!streamId) return undefined;
  return {
    command: PROGRESS_VIEW_COMMANDS.ENABLE_APPROVAL_BYPASS,
    stream: streamId,
    kind,
  };
}

export function handlePermissionAction(
  event: CustomEvent<PermissionActionDetail>,
): void {
  const detail = event.detail;

  switch (detail.kind) {
    case PERMISSION_KIND.TOOL_EDIT: {
      const { data, decision } = detail;
      // The broader action approves the current request like a normal approve
      // and enables auto-approval of file edits for the rest of the run,
      // mirroring the CLI's broader `a` action. Shell commands keep asking.
      // It never reaches the backend approval protocol.
      const isYolo = decision.action === APPROVE_SESSION_ACTION;
      const bypassMessage = isYolo
        ? approvalBypassMessage(data.streamId, PERMISSION_KIND.TOOL_EDIT)
        : undefined;
      const action = isYolo ? 'approve' : decision.action;
      postWithOptionalBypass(bypassMessage, {
        command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
        requestId: data.requestId,
        action,
        ...(decision.action === 'reject' && decision.feedback
          ? { feedback: decision.feedback }
          : {}),
      });
      // Only remove for terminal actions (approve/reject/approveSession).
      // Non-terminal actions like openDiff, previewProposed, showLatexdiff
      // just open editors without settling the approval.
      if (action === 'approve' || action === 'reject') {
        removePrompt(detail.kind, data.requestId);
      }
      break;
    }
    case PERMISSION_KIND.BASH: {
      const { data, decision } = detail;
      // Grants shell-command auto-approval only; file edits keep asking.
      const isYolo = decision.action === APPROVE_SESSION_ACTION;
      const bypassMessage = isYolo
        ? approvalBypassMessage(data.streamId, PERMISSION_KIND.BASH)
        : undefined;
      postWithOptionalBypass(bypassMessage, {
        command: PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION,
        requestId: data.requestId,
        action: decision.action === 'reject' ? decision.action : 'approve',
        ...(decision.action === 'reject' && decision.feedback
          ? { feedback: decision.feedback }
          : {}),
      });
      removePrompt(detail.kind, data.requestId);
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
          viaRelay: data.errorDetails?.isRelayError === true || undefined,
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
      removePrompt(PERMISSION_KIND.RETRY, data.streamId);
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
      const removed = removePrompt(PERMISSION_KIND.PROPOSAL, data.proposalId);
      if (!removed) {
        addResolvedProposalId(data.proposalId);
      }
      break;
    }
    case PERMISSION_KIND.PLAN_APPROVAL: {
      const { data, decision } = detail;
      postPermissionMessage({
        command: PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION,
        approvalId: data.approvalId,
        action: decision.action,
        ...(decision.action === 'reject' && decision.feedback
          ? { feedback: decision.feedback }
          : {}),
      });
      removePrompt(PERMISSION_KIND.PLAN_APPROVAL, data.approvalId);
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
      removePrompt(PERMISSION_KIND.EXTERNAL_INQUIRY, data.requestId);
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
      removePrompt(PERMISSION_KIND.USER_QUESTION, data.requestId);
      break;
    }
  }
}

function postPermissionMessage(message: ProgressViewInboundMessage): void {
  const { command, ...payload } = message;
  postMessage(command, payload);
}
