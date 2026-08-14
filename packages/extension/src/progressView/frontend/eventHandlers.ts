import { create } from 'mutative';

// Local imports - shared webview
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import {
  isToolUseState,
  type GettingStartedActionDetail,
  type ProgressViewInboundMessage,
  type StreamTabId,
} from '@shared/schemas';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';

// Local imports - progress view
import { addResolvedProposalId, removePrompt } from './slices/permissionSlice';
import { updateToolUseState } from './stateUtils';
import { clearInquiryDraft } from './slices/inquiryDraftState';
import {
  APPROVE_SESSION_ACTION,
  APPROVE_ALL_DELEGATED_WORK_ACTION,
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
  requestStreamSwitch(event.detail.streamId);
}

/** Record reversible tab feedback, then ask the backend to hydrate it. */
export function requestStreamSwitch(streamId: StreamTabId): void {
  const requestId = crypto.randomUUID();
  appState.set(
    create(appState.get(), (draft) => {
      draft.pendingStreamSelection = { requestId, streamId };
    }),
  );
  postMessage(PROGRESS_VIEW_COMMANDS.SWITCH_STREAM, {
    stream: streamId,
    requestId,
  });
}

/** Cancel transient tab intent and ask the backend to confirm no selection. */
export function requestStreamDeselection(): void {
  const requestId = crypto.randomUUID();
  appState.set(
    create(appState.get(), (draft) => {
      draft.activeStreamId = null;
      draft.pendingStreamSelection = null;
    }),
  );
  postMessage(PROGRESS_VIEW_COMMANDS.SWITCH_STREAM, {
    stream: '',
    requestId,
  });
}

export function handleStreamDelete(
  event: CustomEvent<StreamEventDetail>,
): void {
  postMessage(PROGRESS_VIEW_COMMANDS.DELETE_STREAM, {
    stream: event.detail.streamId,
  });
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
  streamId: StreamTabId,
): { streamId: StreamTabId; text: string } | null {
  const state = appState.get();
  const streamState = state.streamStates.get(streamId);
  if (!streamState || !isToolUseState(streamState)) return null;

  const text = streamState.ui.followUpText?.trim() ?? '';
  if (!text) return null;

  return { streamId, text };
}

export function handleFollowUpSend(
  event: CustomEvent<FollowUpSendDetail>,
): void {
  const result = getFollowUpText(event.detail.streamId);
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
  updateToolUseState(result.streamId, (prev) =>
    create(prev, (draft) => {
      draft.ui.followUpText = '';
    }),
  );
}

export function handleFollowUpPolish(): void {
  const streamId = appState.get().activeStreamId;
  const result = streamId ? getFollowUpText(streamId) : null;
  if (!result) return;

  postMessage(PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP, {
    stream: result.streamId,
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
    case PERMISSION_KIND.TOOL_EDIT:
    case PERMISSION_KIND.BASH: {
      const { data, decision } = detail;
      // The broader action approves the current request like a normal approve
      // and enables auto-approval of the kind's actions (file edits or shell
      // commands) for the rest of the run, mirroring the CLI's broader `a`
      // action. The other kind keeps asking. It never reaches the backend
      // approval protocol.
      const isYolo = decision.action === APPROVE_SESSION_ACTION;
      const bypassMessage = isYolo
        ? approvalBypassMessage(data.streamId, detail.kind)
        : undefined;
      // The two commands share the requestId/action/feedback payload and differ
      // only in command constant + action vocabulary, but the payload must
      // match a single discriminated message member — branch on the kind and
      // read `detail.decision` inside the branch (a destructured `decision`
      // loses its kind↔action correlation) so `action` narrows to the kind's
      // own set.
      if (detail.kind === PERMISSION_KIND.TOOL_EDIT) {
        const toolDecision = detail.decision;
        postWithOptionalBypass(bypassMessage, {
          command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
          requestId: data.requestId,
          action:
            toolDecision.action === APPROVE_SESSION_ACTION
              ? 'approve'
              : toolDecision.action,
          ...(toolDecision.action === 'reject' && toolDecision.feedback
            ? { feedback: toolDecision.feedback }
            : {}),
        });
      } else {
        const bashDecision = detail.decision;
        postWithOptionalBypass(bypassMessage, {
          command: PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION,
          requestId: data.requestId,
          action:
            bashDecision.action === APPROVE_SESSION_ACTION
              ? 'approve'
              : bashDecision.action,
          ...(bashDecision.action === 'reject' && bashDecision.feedback
            ? { feedback: bashDecision.feedback }
            : {}),
        });
      }
      // Only remove for terminal actions (approve/reject/approveSession).
      // TOOL_EDIT non-terminal actions like openDiff, previewProposed,
      // showLatexdiff just open editors without settling the approval; BASH's
      // action is always terminal after the yolo normalization above.
      if (
        isYolo ||
        decision.action === 'approve' ||
        decision.action === 'reject'
      ) {
        removePrompt(detail.kind, data.requestId);
      }
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
