/**
 * `<run-conversation>`: the body of the selected run. A switch on the
 * run's `documentTask` and `identity.kind` over plain properties; the three
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
      /* One reading measure across the request dock, transcript and footer.
         The log scroller stays full-width; its contents use the same gutter. */
      --conversation-width: 760px;
      --conversation-gutter: var(--wa-space-m);
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

    @container (max-width: 520px) {
      :host {
        --conversation-gutter: var(--wa-space-s);
      }
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

    return run.documentTask
      ? html`<workflow-run-content
          .run=${run}
          .view=${view}
          .surface=${surface}
          .host=${this.host}
        ></workflow-run-content>`
      : html`<tool-use-run-content
          .run=${run}
          .view=${view}
          .surface=${surface}
          .host=${this.host}
        ></tool-use-run-content>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'run-conversation': RunConversation;
  }
}
