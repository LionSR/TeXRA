// Local imports - shared webview
import { postMessage } from '@shared/vscode';

// Local imports - webview commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view
import {
  getStreamState,
  isToolUseState,
  isWorkflowState,
  type StreamFilter,
  type StreamSort,
  type StreamState,
} from './store';
import type {
  FilterEventDetail,
  FollowUpChangeDetail,
  FollowupCommandDetail,
  FollowupModeDetail,
  PermissionActionDetail,
  RunSelectedDetail,
  SortEventDetail,
  StreamEventDetail,
  ToolbarCommandDetail,
} from './events';

// Local imports - shared schemas (types)
import type { StreamTabId } from '@shared/schemas';

// Local imports - component types
import type { FollowUpInput } from './components/FollowUpInput';
import type { ProgressState } from './store';

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
  getFollowUpRef(): FollowUpInput | undefined;
  /** Persist filter/sort preferences to webview state. */
  savePrefs?(
    prefs: Partial<{ streamFilter: StreamFilter; streamSort: StreamSort }>,
  ): void;
}

export function handleStreamSwitch(
  event: CustomEvent<StreamEventDetail>,
): void {
  const { streamId } = event.detail;
  postMessage(PROGRESS_VIEW_COMMANDS.SWITCH_STREAM, { stream: streamId });
}

export function handleStreamDelete(
  event: CustomEvent<StreamEventDetail>,
): void {
  const { streamId } = event.detail;
  postMessage(PROGRESS_VIEW_COMMANDS.DELETE_STREAM, { stream: streamId });
}

export function handleFilterChange(
  event: CustomEvent<FilterEventDetail>,
  ctx: FrontendEventHandlerContext,
): void {
  const { filter } = event.detail;
  ctx.setState((prev) => ({ ...prev, streamFilter: filter }));
  ctx.savePrefs?.({ streamFilter: filter });
  postMessage(PROGRESS_VIEW_COMMANDS.FILTER_STREAMS, { filter });
}

export function handleSortChange(
  event: CustomEvent<SortEventDetail>,
  ctx: FrontendEventHandlerContext,
): void {
  const { sort } = event.detail;
  ctx.setState((prev) => ({ ...prev, streamSort: sort }));
  ctx.savePrefs?.({ streamSort: sort });
  postMessage(PROGRESS_VIEW_COMMANDS.SORT_STREAMS, { sortBy: sort });
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

export function handleRunSelected(
  event: CustomEvent<RunSelectedDetail>,
  ctx: FrontendEventHandlerContext,
): void {
  const { runId } = event.detail;
  const state = ctx.getState();
  const streamId = state.activeStreamId;
  if (!streamId) return;

  ctx.setStreamState(streamId, (prev) => {
    if (!isWorkflowState(prev)) return prev;
    return { ...prev, selectedRunId: runId };
  });
}

export function handleFileAction(
  event: CustomEvent<Record<string, string>>,
): void {
  const { command, ...payload } = event.detail;
  if (!command) return;
  postMessage(command, payload);
}

export function handleFollowUpChange(
  event: CustomEvent<FollowUpChangeDetail>,
  ctx: FrontendEventHandlerContext,
): void {
  const { value } = event.detail;
  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;
  ctx.setStreamState(streamId, (prev) => {
    if (!isToolUseState(prev)) return prev;
    return { ...prev, followUpText: value };
  });
}

export function handleFollowUpSend(ctx: FrontendEventHandlerContext): void {
  const state = ctx.getState();
  const streamId = state.activeStreamId;
  if (!streamId) return;

  const streamState = getStreamState(state, streamId);
  if (!isToolUseState(streamState)) return;

  const text = streamState.followUpText?.trim() ?? '';
  if (!text) return;

  postMessage(PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP, {
    stream: streamId,
    text,
  });
  ctx.setStreamState(streamId, (prev) => {
    if (!isToolUseState(prev)) return prev;
    return { ...prev, followUpText: '' };
  });
}

export function handleFollowUpPolish(ctx: FrontendEventHandlerContext): void {
  const state = ctx.getState();
  const streamId = state.activeStreamId;
  if (!streamId) return;

  const streamState = getStreamState(state, streamId);
  if (!isToolUseState(streamState)) return;

  const text = streamState.followUpText?.trim() ?? '';
  if (!text) return;

  postMessage(PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP, {
    stream: streamId,
    text,
  });
}

export function handleFollowUpClear(ctx: FrontendEventHandlerContext): void {
  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;
  ctx.setStreamState(streamId, (prev) => {
    if (!isToolUseState(prev)) return prev;
    return { ...prev, followUpText: '' };
  });
}

export function handleFollowupRequestOptions(
  ctx: FrontendEventHandlerContext,
): void {
  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;
  postMessage(PROGRESS_VIEW_COMMANDS.GET_FOLLOWUP_OPTIONS, {
    stream: streamId,
  });
}

export function handleFollowupModeChange(
  event: CustomEvent<FollowupModeDetail>,
  ctx: FrontendEventHandlerContext,
): void {
  const { mode } = event.detail;
  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;
  ctx.setStreamState(streamId, (prev) => {
    if (!isWorkflowState(prev)) return prev;
    return { ...prev, followupMode: mode };
  });
}

export function handleFollowupSetup(
  event: CustomEvent<FollowupCommandDetail>,
  ctx: FrontendEventHandlerContext,
): void {
  sendFollowupCommand(PROGRESS_VIEW_COMMANDS.SETUP_FOLLOWUP, event, ctx);
}

export function handleFollowupRun(
  event: CustomEvent<FollowupCommandDetail>,
  ctx: FrontendEventHandlerContext,
): void {
  sendFollowupCommand(PROGRESS_VIEW_COMMANDS.RUN_FOLLOWUP, event, ctx);
}

function sendFollowupCommand(
  command: string,
  event: CustomEvent<FollowupCommandDetail>,
  ctx: FrontendEventHandlerContext,
): void {
  const stream = ctx.getState().activeStreamId;
  if (!stream) return;

  const {
    mode,
    agent,
    model,
    includeInstruction,
    attachOutputs,
    initialQuestion,
  } = event.detail;

  postMessage(command, {
    stream,
    mode,
    agent,
    model,
    includeInstruction: mode === 'workflow' ? includeInstruction : false,
    attachAgentOutputs: mode === 'workflow' ? attachOutputs : false,
    initialQuestion,
  });
}

export function handlePermissionAction(
  event: CustomEvent<PermissionActionDetail>,
): void {
  const { permission, action, feedback } = event.detail;

  switch (permission.kind) {
    case 'toolEdit':
      postMessage(PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION, {
        requestId: permission.data.requestId,
        action,
        feedback,
      });
      break;
    case 'bash':
      postMessage(PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION, {
        requestId: permission.data.requestId,
        action,
        feedback,
      });
      break;
    case 'retry':
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
      break;
    case 'proposal':
      postMessage(PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION, {
        proposalId: permission.data.proposalId,
        action,
        feedback,
      });
      break;
  }
}
