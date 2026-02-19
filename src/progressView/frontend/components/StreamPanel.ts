/**
 * Per-stream context provider wrapper.
 *
 * Provides stream-specific `streamStateContext` and `streamLogContext`
 * to its children, isolating each stream panel's data. This enables
 * the "render all visited, hide non-active" pattern for instant tab
 * switching without DOM destruction/recreation.
 *
 * When a panel is hidden (non-active stream), its DOM subtree is preserved
 * in memory. Switching back to it is instant — no re-rendering, no
 * re-formatting of log entries. Only the active panel receives live
 * data updates from the backend.
 */

// Third-party imports
import { LitElement, css, html, type PropertyValues, type TemplateResult } from 'lit';
import { provide } from '@lit/context';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared utilities
import { getEffectiveRunId } from '@shared/streams/runSelection';

// Local imports - progress view store
import {
  isToolUseState,
  EMPTY_STREAM_LOGS,
  type StreamState,
  type StreamLogs,
  type FollowupOptionsState,
} from '../store';

// Local imports - progress view contexts
import {
  EMPTY_LOG_CONTEXT,
  EMPTY_STREAM_CONTEXT,
  streamLogContext,
  streamStateContext,
  type StreamContextValue,
  type StreamLogContextValue,
} from '../contexts/streamContexts';

// Local imports - shared schemas
import type { StreamTabInfo } from '@shared/schemas';

@customElement('stream-panel')
export class StreamPanel extends LitElement {
  static override styles = css`
    :host {
      display: contents;
    }
    :host([hidden]) {
      display: none;
    }
  `;

  @property({ attribute: false }) streamInfo: StreamTabInfo | null = null;
  @property({ attribute: false }) streamState: StreamState | null = null;
  @property({ attribute: false }) streamLogs: StreamLogs = EMPTY_STREAM_LOGS;
  @property({ attribute: false }) followupOptions: FollowupOptionsState | null =
    null;
  @property({ attribute: false }) hasStreams = false;

  @provide({ context: streamStateContext })
  @state()
  private streamContextValue: StreamContextValue = EMPTY_STREAM_CONTEXT;

  @provide({ context: streamLogContext })
  @state()
  private streamLogContextValue: StreamLogContextValue = EMPTY_LOG_CONTEXT;

  protected override willUpdate(changed: PropertyValues): void {
    if (
      changed.has('streamInfo') ||
      changed.has('streamState') ||
      changed.has('streamLogs') ||
      changed.has('followupOptions') ||
      changed.has('hasStreams')
    ) {
      this.updateContexts();
    }
  }

  private updateContexts(): void {
    const { streamInfo, streamState, streamLogs, followupOptions, hasStreams } =
      this;

    if (!streamInfo || !streamState) {
      this.streamContextValue = { ...EMPTY_STREAM_CONTEXT, hasStreams };
      this.streamLogContextValue = { ...EMPTY_LOG_CONTEXT, hasStreams };
      return;
    }

    const isToolUse = isToolUseState(streamState);
    const runId = getEffectiveRunId(streamState, { mode: 'fallback' });

    // Log context: ref-equality guard to avoid unnecessary consumer re-renders
    const prevLog = this.streamLogContextValue;
    if (
      prevLog.logs !== streamLogs.logs ||
      prevLog.taskGroups !== streamState.taskGroups ||
      prevLog.runId !== runId ||
      prevLog.isToolUse !== isToolUse ||
      prevLog.hasStreams !== hasStreams ||
      prevLog.streamName !== streamInfo.name
    ) {
      this.streamLogContextValue = {
        logs: streamLogs.logs,
        taskGroups: streamState.taskGroups,
        runId,
        isToolUse,
        hasStreams,
        streamName: streamInfo.name,
      };
    }

    // Meta context: ref-equality guard
    const prevCtx = this.streamContextValue;
    if (
      prevCtx.streamInfo !== streamInfo ||
      prevCtx.streamState !== streamState ||
      prevCtx.runId !== runId ||
      prevCtx.followupOptions !== followupOptions ||
      prevCtx.isToolUse !== isToolUse ||
      prevCtx.hasStreams !== hasStreams
    ) {
      this.streamContextValue = {
        streamInfo,
        streamState,
        runId,
        followupOptions,
        isToolUse,
        hasStreams,
      };
    }
  }

  override render(): TemplateResult {
    return html`<slot></slot>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'stream-panel': StreamPanel;
  }
}
