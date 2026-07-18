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

import './LogList';

@customElement('process-stream-content')
export class ProcessStreamContent extends LitElement {
  static override styles = css`
    :host {
      display: contents;
    }

    /* "$ <command>" strip above the process output. */
    .command-strip {
      display: flex;
      align-items: baseline;
      gap: var(--wa-space-2xs);
      padding: var(--wa-space-2xs) var(--wa-space-s);
      margin: 0 0 var(--wa-space-2xs) 0;
      background: var(
        --wa-color-terminal-background,
        var(--wa-color-surface-default, transparent)
      );
      color: var(--wa-color-terminal-foreground, var(--wa-color-text-normal));
      border: var(--border-thin) solid
        var(--wa-color-surface-border, transparent);
      border-radius: var(--border-radius-small);
      font-family: var(
        --wa-font-family-mono,
        ui-monospace,
        SFMono-Regular,
        Consolas,
        monospace
      );
      font-size: var(--wa-editor-font-size, var(--font-size-sm));
      max-height: min(32vh, 320px);
      overflow-y: auto;
      overflow-x: hidden;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .command-strip > span {
      min-width: 0;
    }

    .prompt {
      color: var(--wa-color-terminal-ansi-green, var(--color-success, #0a0));
      font-weight: var(--font-weight-semibold);
      user-select: none;
      flex: 0 0 auto;
    }

    .command {
      flex: 1 1 auto;
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
    const command = (
      (streamInfo.kind === 'process' ? streamInfo.command : undefined) ??
      streamInfo.description ??
      ''
    ).trim();

    return html`
      ${renderStreamHeader(
        streamInfo,
        streamState,
        this.streamContext.unsupportedCommands,
      )}
      ${
        command
          ? html`
              <div class="command-strip">
                <span class="prompt">$</span>
                <span class="command">${command}</span>
              </div>
            `
          : nothing
      }

      <log-list></log-list>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'process-stream-content': ProcessStreamContent;
  }
}
