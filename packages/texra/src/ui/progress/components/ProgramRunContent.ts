/**
 * A program run's conversation: its pending requests, then the transcript
 * log, the usage it closes with, and once it has ended, what the user can do next. Reads the view
 * and the surface; every send is a child's event.
 */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Local imports - progress view
import { BaseRunContent } from './BaseRunContent';
import { conversationContentStyles } from './ConversationContent.styles';

@customElement('program-run-content')
export class ProgramRunContent extends BaseRunContent {
  static override styles = conversationContentStyles;

  override render(): TemplateResult | typeof nothing {
    const { run, view, surface } = this;
    if (!run || !view || !surface || !run.program) return nothing;
    return html`
      <div class="conversation-content">
        ${this.renderLog()}

        <div class="conversation-column conversation-epilogue">
          ${this.renderUsagePanel(run)}
        </div>
        ${this.renderApprovalDock()}
      </div>
      ${
        run.holder === 'here'
          ? nothing
          : html`<div class="conversation-composer-dock">
              <div class="conversation-column">
                ${this.renderEndedLine(run)}
              </div>
            </div>`
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'program-run-content': ProgramRunContent;
  }
}
