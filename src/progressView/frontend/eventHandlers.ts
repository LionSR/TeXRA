// Local imports - shared webview
import { postMessage } from '@shared/vscode';

// Local imports - webview commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view
import type { PromptState } from './components/PromptOverlay';
import { getStreamState, type FollowupMode, type StreamState } from './store';

// Local imports - shared schemas (types)
import type { StreamTabId } from '@shared/schemas';

// Local imports - component types
import type { FollowUpInput } from './components/FollowUpInput';
import type { LogList } from './components/LogList';
import type { ProgressState, StreamFilter, StreamSort } from './store';

/**
 * Context passed to event handlers providing access to state and refs.
 */
export interface EventHandlerContext {
  getState(): ProgressState;
  setState(updater: (prev: ProgressState) => ProgressState): void;
  setStreamState(
    streamId: StreamTabId,
    updater: (prev: StreamState) => StreamState,
  ): void;
  getLogListRef(): LogList | undefined;
  getFollowUpRef(): FollowUpInput | undefined;
}

export function handleStreamSwitch(event: CustomEvent): void {
  const { streamId } = event.detail as { streamId: string };
  postMessage(PROGRESS_VIEW_COMMANDS.SWITCH_STREAM, { stream: streamId });
}

export function handleStreamDelete(event: CustomEvent): void {
  const { streamId } = event.detail as { streamId: string };
  postMessage(PROGRESS_VIEW_COMMANDS.DELETE_STREAM, { stream: streamId });
}

export function handleFilterChange(
  event: CustomEvent,
  ctx: EventHandlerContext,
): void {
  const { filter } = event.detail as { filter: StreamFilter };
  ctx.setState((prev) => ({ ...prev, streamFilter: filter }));
  postMessage(PROGRESS_VIEW_COMMANDS.FILTER_STREAMS, { filter });
}

export function handleSortChange(
  event: CustomEvent,
  ctx: EventHandlerContext,
): void {
  const { sort } = event.detail as { sort: StreamSort };
  ctx.setState((prev) => ({ ...prev, streamSort: sort }));
  postMessage(PROGRESS_VIEW_COMMANDS.SORT_STREAMS, { sortBy: sort });
}

export function handleDeleteAll(): void {
  postMessage(PROGRESS_VIEW_COMMANDS.DELETE_ALL, {});
}

export function handleToolbarCommand(
  event: CustomEvent,
  ctx: EventHandlerContext,
): void {
  const { command } = event.detail as { command: string };
  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;
  postMessage(command, { stream: streamId });
}

export function handleRunSelected(
  event: CustomEvent,
  ctx: EventHandlerContext,
): void {
  const { runId } = event.detail as { runId: string | null };
  const state = ctx.getState();
  const streamId = state.activeStreamId;
  if (!streamId) return;

  ctx.setStreamState(streamId, (prev) => ({
    ...prev,
    selectedRunId: runId,
  }));

  ctx.getLogListRef()?.showRun(runId ?? null);
}

export function handleFileAction(event: CustomEvent): void {
  const detail = event.detail as Record<string, string>;
  const { command, ...payload } = detail;
  if (!command) return;
  postMessage(command, payload);
}

export function handleFollowUpChange(
  event: CustomEvent,
  ctx: EventHandlerContext,
): void {
  const { value } = event.detail as { value: string };
  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;
  ctx.setStreamState(streamId, (prev) => ({ ...prev, followUpText: value }));
}

export function handleFollowUpSend(ctx: EventHandlerContext): void {
  const state = ctx.getState();
  const streamId = state.activeStreamId;
  if (!streamId) return;

  const streamState = getStreamState(state, streamId);
  const text = streamState.followUpText?.trim() ?? '';
  if (!text) return;

  postMessage(PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP, {
    stream: streamId,
    text,
  });
  ctx.setStreamState(streamId, (prev) => ({ ...prev, followUpText: '' }));
}

export function handleFollowUpPolish(ctx: EventHandlerContext): void {
  const state = ctx.getState();
  const streamId = state.activeStreamId;
  if (!streamId) return;

  const streamState = getStreamState(state, streamId);
  const text = streamState.followUpText?.trim() ?? '';
  if (!text) return;

  postMessage(PROGRESS_VIEW_COMMANDS.POLISH_FOLLOW_UP, {
    stream: streamId,
    text,
  });
}

export function handleFollowUpClear(ctx: EventHandlerContext): void {
  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;
  ctx.setStreamState(streamId, (prev) => ({ ...prev, followUpText: '' }));
}

export function handleFollowUpToggleBypass(ctx: EventHandlerContext): void {
  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;
  postMessage(PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS, {
    stream: streamId,
  });
}

export function handleFollowupRequestOptions(ctx: EventHandlerContext): void {
  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;
  postMessage(PROGRESS_VIEW_COMMANDS.GET_FOLLOWUP_OPTIONS, {
    stream: streamId,
  });
}

export function handleFollowupModeChange(
  event: CustomEvent,
  ctx: EventHandlerContext,
): void {
  const { mode } = event.detail as { mode: FollowupMode };
  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;
  ctx.setStreamState(streamId, (prev) => ({ ...prev, followupMode: mode }));
}

export function handleFollowupSetup(
  event: CustomEvent,
  ctx: EventHandlerContext,
): void {
  sendFollowupCommand(PROGRESS_VIEW_COMMANDS.SETUP_FOLLOWUP, event, ctx);
}

export function handleFollowupRun(
  event: CustomEvent,
  ctx: EventHandlerContext,
): void {
  sendFollowupCommand(PROGRESS_VIEW_COMMANDS.RUN_FOLLOWUP, event, ctx);
}

function sendFollowupCommand(
  command: string,
  event: CustomEvent,
  ctx: EventHandlerContext,
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
  } = event.detail as {
    mode: string;
    agent: string;
    model: string;
    includeInstruction: boolean;
    attachOutputs: boolean;
    initialQuestion: string;
  };

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

export function handlePromptAction(event: CustomEvent): void {
  const { prompt, action } = event.detail as {
    prompt: PromptState;
    action: string;
  };

  switch (prompt.kind) {
    case 'toolEdit':
      postMessage(PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION, {
        requestId: prompt.data.requestId,
        action,
      });
      break;
    case 'bash':
      postMessage(PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION, {
        requestId: prompt.data.requestId,
        action,
      });
      break;
    case 'retry':
      if (action === 'retry') {
        postMessage(PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST, {
          stream: prompt.data.streamId,
        });
      } else {
        postMessage(PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST, {
          stream: prompt.data.streamId,
        });
      }
      break;
    case 'proposal':
      postMessage(PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION, {
        proposalId: prompt.data.proposalId,
        action,
      });
      break;
  }
}
