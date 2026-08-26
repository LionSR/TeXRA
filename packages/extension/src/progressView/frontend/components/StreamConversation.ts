/** `<stream-conversation>` — body of the Progress view's active stream. */

// Third-party imports
import { LitElement, css, html, type TemplateResult } from 'lit';
import { provide } from '@lit/context';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared
import type {
  InquiryThreadUpdatedEvent,
  PermissionPayload,
} from '@shared/schemas';
import { SignalWatcher } from '@shared/signals';

// Local imports - progress view
import {
  activeInquiries$,
  logContext$,
  permissions$,
  phaseStages$,
  streamById$,
  streamContext$,
} from '../progressState';
import {
  archivedContext,
  EMPTY_INQUIRY_THREADS,
  EMPTY_LOG_CONTEXT,
  EMPTY_PHASE_STAGE_MAP,
  EMPTY_STREAM_BY_ID,
  EMPTY_STREAM_CONTEXT,
  followUpEventSinkContext,
  inquiryThreadsContext,
  permissionsContext,
  phaseStagesContext,
  streamByIdContext,
  streamLogContext,
  streamStateContext,
  type FollowUpEventSink,
  type PhaseStageMap,
  type StreamByIdMap,
  type StreamContextValue,
  type StreamLogContextValue,
} from '../streamContexts';

// Side-effect imports - body components rendered below.
import './ToolUseStreamContent';
import './WorkflowStreamContent';
import './ProcessStreamContent';
import './LogList';

@customElement('stream-conversation')
export class StreamConversation extends SignalWatcher(LitElement) {
  static override styles = css`
    :host {
      /* Body text renders at --wa-font-size-m (13px from the host), so 800px
         put the measure near 127 characters per line — roughly double the
         60-75 that keeps the eye finding the next line. Code blocks and
         diffs are free to overflow this column. */
      --conversation-reading-width: 680px;
      --conversation-header-width: 1040px;

      container-type: inline-size;
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      background: var(--wa-color-surface-default);
      color: var(--wa-color-text-normal);
    }

    tool-use-stream-content,
    workflow-stream-content,
    process-stream-content {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }
  `;

  @provide({ context: streamStateContext })
  @state()
  private streamContextValue: StreamContextValue = EMPTY_STREAM_CONTEXT;

  @provide({ context: streamLogContext })
  @state()
  private streamLogContextValue: StreamLogContextValue = EMPTY_LOG_CONTEXT;

  @provide({ context: permissionsContext })
  @state()
  private permissionsContextValue: PermissionPayload[] = [];

  @provide({ context: streamByIdContext })
  @state()
  private streamByIdContextValue: StreamByIdMap = EMPTY_STREAM_BY_ID;

  @provide({ context: inquiryThreadsContext })
  @state()
  private inquiryThreadsContextValue: InquiryThreadUpdatedEvent[] =
    EMPTY_INQUIRY_THREADS;

  @provide({ context: phaseStagesContext })
  @state()
  private phaseStagesContextValue: PhaseStageMap = EMPTY_PHASE_STAGE_MAP;

  @provide({ context: followUpEventSinkContext })
  private readonly followUpEventSink: FollowUpEventSink = (event) => {
    this.dispatchEvent(event);
  };

  /**
   * Externally settable (unlike the signal-derived contexts above): every
   * live host leaves this `false`; the trace-viewer sets it once at mount
   * (`conversationView.archived = true`) since it has no live backend for
   * request-panel actions to reach.
   */
  @provide({ context: archivedContext })
  @property({ type: Boolean })
  archived = false;

  /** Sync signal-computed values into @provide/@state context properties. */
  protected override willUpdate(): void {
    this.streamContextValue = streamContext$.get();
    this.streamLogContextValue = logContext$.get();
    this.permissionsContextValue = permissions$.get();
    this.streamByIdContextValue = streamById$.get();
    this.inquiryThreadsContextValue = activeInquiries$.get();
    this.phaseStagesContextValue = phaseStages$.get();
  }

  override render(): TemplateResult {
    const { streamInfo, streamState, isToolUse } = this.streamContextValue;

    // No active stream — show empty log-list.
    if (!streamInfo || !streamState) {
      return html`<log-list></log-list>`;
    }

    // Process agents (e.g. bash) proxy raw stdout/stderr — render them with
    // a dedicated terminal-style container, not the LLM workflow/tool-use
    // chrome.
    if (streamInfo.identity?.kind === 'process') {
      return html`<process-stream-content></process-stream-content>`;
    }

    if (isToolUse) {
      return html`<tool-use-stream-content></tool-use-stream-content>`;
    }

    // Workflow stream (default for non-tool-use).
    return html`<workflow-stream-content></workflow-stream-content>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'stream-conversation': StreamConversation;
  }
}
