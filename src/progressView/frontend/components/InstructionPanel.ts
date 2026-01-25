// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';

// Local imports - shared utilities
import { copyWithFeedback } from '@shared/utils/clipboard';

// Local imports - progress view constants
import { ELEMENT_IDS } from '../constants';

// Local imports - shared schemas
import type { InstructionUpdate } from '@shared/schemas';

@customElement('instruction-panel')
export class InstructionPanel extends LitElement {
  @property({ type: Object }) instruction: InstructionUpdate | null = null;

  @query(`#${ELEMENT_IDS.INSTRUCTION_COPY_BTN}`)
  declare private copyButton: HTMLElement | null;

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  render(): TemplateResult | typeof nothing {
    const text = this.instruction?.text ?? '';
    if (!text.trim()) {
      return nothing;
    }

    return html`
      <div
        id=${ELEMENT_IDS.INSTRUCTION_CONTAINER}
        class="instruction-panel is-visible"
      >
        <div class="instruction-panel__header">
          <span class="instruction-panel__title">
            <i class="codicon codicon-notebook"></i>
            <span>Instructions</span>
          </span>
          <vscode-toolbar-container class="instruction-panel__actions">
            <vscode-toolbar-button
              id=${ELEMENT_IDS.INSTRUCTION_COPY_BTN}
              class="instruction-panel__copy"
              icon="copy"
              label="Copy instruction"
              title="Copy instruction"
              data-default-title="Copy instruction"
              data-success-title="Copied!"
              @click=${this.handleCopy}
            ></vscode-toolbar-button>
          </vscode-toolbar-container>
        </div>
        <div class="instruction-panel__body" role="presentation">
          <vscode-textarea
            id=${ELEMENT_IDS.INSTRUCTION_TEXT}
            class="instruction-panel__text"
            .value=${text}
            readonly
            resize="none"
            rows="8"
          ></vscode-textarea>
        </div>
      </div>
    `;
  }

  private async handleCopy(event: Event) {
    event.preventDefault();
    const text = this.instruction?.text ?? '';
    if (!text.trim()) return;

    if (!this.copyButton) return;

    await copyWithFeedback(this.copyButton, text, {
      defaultTitle: this.copyButton.getAttribute('title') || 'Copy instruction',
      successTitle: 'Copied!',
    });
  }
}
