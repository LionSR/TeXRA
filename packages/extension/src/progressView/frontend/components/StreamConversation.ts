/** `<stream-conversation>` — body of the Progress view's active stream. */

// Third-party imports
import { LitElement, css, html, type TemplateResult } from 'lit';
import { provide } from '@lit/context';
import { customElement, state } from 'lit/decorators.js';

// Local imports - shared
import type { InquiryThreadUpdatedEvent } from '@shared/schemas';
import { SignalWatcher } from '@shared/signals';
import { isProcessAgent } from '@shared/streams/agentKind';

// Local imports - progress view
import {
  activeInquiries$,
  activeProcessOutputs$,
  logContext$,
  permissions$,
  streamById$,
  streamContext$,
} from '../progressState';
import {
  EMPTY_INQUIRY_THREADS,
  EMPTY_LOG_CONTEXT,
  EMPTY_PROCESS_OUTPUTS,
  EMPTY_STREAM_BY_ID,
  EMPTY_STREAM_CONTEXT,
  inquiryThreadsContext,
  permissionsContext,
  processOutputContext,
  streamByIdContext,
  streamLogContext,
  streamStateContext,
  type ProcessOutputMap,
  type StreamByIdMap,
  type StreamContextValue,
  type StreamLogContextValue,
} from '../contexts/streamContexts';
import type { PermissionState } from './PermissionCard';

// Side-effect imports - body components rendered below.
import './ToolUseStreamContent';
import './WorkflowStreamContent';
import './ProcessStreamContent';
import './LogList';

@customElement('stream-conversation')
export class StreamConversation extends SignalWatcher(LitElement) {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }

    tool-use-stream-content,
    workflow-stream-content,
    process-stream-content {
      display: contents;
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
  private permissionsContextValue: PermissionState[] = [];

  @provide({ context: processOutputContext })
  @state()
  private processOutputContextValue: ProcessOutputMap = EMPTY_PROCESS_OUTPUTS;

  @provide({ context: streamByIdContext })
  @state()
  private streamByIdContextValue: StreamByIdMap = EMPTY_STREAM_BY_ID;

  @provide({ context: inquiryThreadsContext })
  @state()
  private inquiryThreadsContextValue: InquiryThreadUpdatedEvent[] =
    EMPTY_INQUIRY_THREADS;

  /** Sync signal-computed values into @provide/@state context properties. */
  protected override willUpdate(): void {
    this.streamContextValue = streamContext$.get();
    this.streamLogContextValue = logContext$.get();
    this.permissionsContextValue = permissions$.get();
    this.processOutputContextValue = activeProcessOutputs$.get();
    this.streamByIdContextValue = streamById$.get();
    this.inquiryThreadsContextValue = activeInquiries$.get();
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
    if (isProcessAgent(streamInfo.agent)) {
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
