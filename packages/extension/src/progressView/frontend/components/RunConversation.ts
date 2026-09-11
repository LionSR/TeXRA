/**
 * `<run-conversation>`: the body of the selected run. A switch on the
 * run's `category` and `identity.kind` over plain properties; the three
 * bodies take the same four records and nothing is provided by context.
 */
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { HostSnapshot } from '@shared/session/hostSnapshot';
import type { SessionView, RunView } from '@shared/session/sessionView';
import type { Surface } from '@shared/session/surface';

import './ToolUseRunContent';
import './WorkflowRunContent';
import './ProcessRunContent';

@customElement('run-conversation')
export class RunConversation extends LitElement {
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

    tool-use-run-content,
    workflow-run-content,
    process-run-content {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }
  `;

  @property({ attribute: false }) run: RunView | null = null;
  @property({ attribute: false }) view: SessionView | null = null;
  @property({ attribute: false }) surface: Surface | null = null;
  @property({ attribute: false }) host: HostSnapshot | null = null;
  /** The host's clock, for elapsed readings (G4). */
  @property({ type: Number }) nowMs: number | null = null;

  override render(): TemplateResult | typeof nothing {
    const { run, view, surface } = this;
    if (!run || !view || !surface) return nothing;

    if (run.identity.kind === 'process') {
      return html`<process-run-content
        .run=${run}
        .view=${view}
        .surface=${surface}
        .host=${this.host}
      ></process-run-content>`;
    }

    switch (run.category) {
      case 'toolUse':
        return html`<tool-use-run-content
          .run=${run}
          .view=${view}
          .surface=${surface}
          .host=${this.host}
          .nowMs=${this.nowMs}
        ></tool-use-run-content>`;
      case 'workflow':
        return html`<workflow-run-content
          .run=${run}
          .view=${view}
          .surface=${surface}
          .nowMs=${this.nowMs}
        ></workflow-run-content>`;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'run-conversation': RunConversation;
  }
}
