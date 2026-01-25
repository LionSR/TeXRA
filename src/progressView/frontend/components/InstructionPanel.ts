// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';

// Local imports - common helpers
import { copyWithFeedback } from '@common/modules/clipboardUtils.js';

// Local imports - progress view constants
import { ELEMENT_IDS } from '../constants';

// Local imports - shared schemas
import type { InstructionUpdate } from '@shared/schemas';

@customElement('instruction-panel')
export class InstructionPanel extends LitElement {
  @property({ type: Object }) instruction: InstructionUpdate | null = null;

  @query(`#${ELEMENT_IDS.INSTRUCTION_COPY_BTN}`)
  private declare copyButton: HTMLElement | null;

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  render(): TemplateResult {
    const text = this.instruction?.text ?? '';
    const isVisible = Boolean(text.trim());

    return html`
      <div
        id=${ELEMENT_IDS.INSTRUCTION_CONTAINER}
        class="instruction-panel ${isVisible ? 'is-visible' : ''}"
        aria-hidden=${isVisible ? 'false' : 'true'}
      >
        <div class="instruction-panel__header">
          <div class="instruction-panel__title">
            <i class="codicon codicon-lightbulb"></i>
            Instruction
          </div>
          <div class="instruction-panel__actions">
            <vscode-toolbar-button
              id=${ELEMENT_IDS.INSTRUCTION_COPY_BTN}
              class="instruction-panel__copy"
              icon="copy"
              title="Copy instruction"
              aria-label="Copy instruction"
              ?disabled=${!isVisible}
              @click=${this.handleCopy}
            ></vscode-toolbar-button>
          </div>
        </div>
        <div class="instruction-panel__body">
          <vscode-text-area
            id=${ELEMENT_IDS.INSTRUCTION_TEXT}
            class="instruction-panel__text"
            .value=${text}
            readonly
          ></vscode-text-area>
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
