/** Container for process-agent streams (e.g. `bash` child tabs). */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { consume } from '@lit/context';
import { customElement, state } from 'lit/decorators.js';

import {
  EMPTY_STREAM_CONTEXT,
  streamStateContext,
  type StreamContextValue,
} from '../contexts/streamContexts';
import { isToolUseState } from '../store';

import './StreamHeader';
import './TerminalCommandStrip';
import './LogList';

@customElement('process-stream-content')
export class ProcessStreamContent extends LitElement {
  static override styles = css`
    :host {
      display: contents;
    }
  `;

  @consume({ context: streamStateContext, subscribe: true })
  @state()
  private streamContext: StreamContextValue = EMPTY_STREAM_CONTEXT;

  override render(): TemplateResult | typeof nothing {
    const streamInfo = this.streamContext.streamInfo;
    const streamState = this.streamContext.streamState;
    if (!streamInfo || !streamState) return nothing;

    // Bash streams register as tool-use kind; bind bypass toggles so the
    // header reflects active YOLO / Super YOLO state.
    const toolUse = isToolUseState(streamState) ? streamState : null;
    const command = streamInfo.command ?? streamInfo.description ?? '';

    return html`
      <stream-header
        .stream=${streamInfo}
        .status=${streamState.status}
        .progress=${streamState.conversationProgress}
        .yoloActive=${Boolean(toolUse?.toolEditBypass)}
        .superYoloActive=${Boolean(toolUse?.superYoloBypass)}
        .odysseyActive=${Boolean(toolUse?.odysseyActive)}
      ></stream-header>

      <terminal-command-strip .command=${command}></terminal-command-strip>

      <log-list></log-list>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'process-stream-content': ProcessStreamContent;
  }
}
