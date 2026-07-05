/** Container for process-agent streams (e.g. `bash` child tabs). */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { consume } from '@lit/context';
import { customElement, state } from 'lit/decorators.js';

import {
  EMPTY_STREAM_CONTEXT,
  streamStateContext,
  type StreamContextValue,
} from '../contexts/streamContexts';
import { renderStreamHeader } from './streamHeaderView';

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

    // Bash streams register as tool-use kind, so renderStreamHeader reflects
    // their active YOLO / Super YOLO state from the shared tool-use fields.
    const command = streamInfo.command ?? streamInfo.description ?? '';

    return html`
      ${renderStreamHeader(
        streamInfo,
        streamState,
        this.streamContext.unsupportedCommands,
      )}

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
