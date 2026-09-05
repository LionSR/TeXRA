/**
 * `<stream-conversation>`: the body of the selected stream. A switch on the
 * stream's `category` and `identity.kind` over plain properties; the three
 * bodies take the same four records and nothing is provided by context.
 */
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { HostSnapshot } from '@shared/session/hostSnapshot';
import type { SessionView, StreamView } from '@shared/session/sessionView';
import type { Surface } from '@shared/session/surface';

import './ToolUseStreamContent';
import './WorkflowStreamContent';
import './ProcessStreamContent';

@customElement('stream-conversation')
export class StreamConversation extends LitElement {
  static override styles = css`
    :host {
      /* The transcript spans the panel instead of a fixed reading column:
         each consumer (.conversation-column, .log-container, .log-header)
         applies its own inline gutter. Code blocks and diffs are free to
         overflow the content box. */

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

  @property({ attribute: false }) stream: StreamView | null = null;
  @property({ attribute: false }) view: SessionView | null = null;
  @property({ attribute: false }) surface: Surface | null = null;
  @property({ attribute: false }) host: HostSnapshot | null = null;
  /** The host's clock, for elapsed readings (G4). */
  @property({ type: Number }) nowMs: number | null = null;

  override render(): TemplateResult | typeof nothing {
    const { stream, view, surface } = this;
    if (!stream || !view || !surface) return nothing;

    if (stream.identity?.kind === 'process') {
      return html`<process-stream-content
        .stream=${stream}
        .view=${view}
        .surface=${surface}
        .host=${this.host}
      ></process-stream-content>`;
    }

    switch (stream.category) {
      case 'toolUse':
        return html`<tool-use-stream-content
          .stream=${stream}
          .view=${view}
          .surface=${surface}
          .host=${this.host}
          .nowMs=${this.nowMs}
        ></tool-use-stream-content>`;
      case 'workflow':
        return html`<workflow-stream-content
          .stream=${stream}
          .view=${view}
          .surface=${surface}
          .nowMs=${this.nowMs}
        ></workflow-stream-content>`;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'stream-conversation': StreamConversation;
  }
}
