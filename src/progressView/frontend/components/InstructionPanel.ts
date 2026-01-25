// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';

// Local imports - shared styles
// Note: Design tokens from tokens.css are inherited into Shadow DOM via :root
import { codiconIconClasses } from '@shared/styles/codiconStyles';

// Local imports - shared utilities
import { copyWithFeedback } from '@shared/utils/clipboard';

// Local imports - progress view constants
import { ELEMENT_IDS } from '../constants';

// Local imports - shared schemas
import type { InstructionUpdate } from '@shared/schemas';

@customElement('instruction-panel')
export class InstructionPanel extends LitElement {
  static styles = [
    codiconIconClasses,
    css`
      :host {
        display: none;
        border-top: var(--border-thin) solid var(--color-border);
        border-bottom: var(--border-thin) solid var(--color-border);
        background-color: transparent;
      }

      :host([visible]) {
        display: block;
      }

      :host([hidden]) {
        display: none;
      }

      .instruction-panel__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-small) var(--spacing-medium);
        gap: var(--spacing-small);
      }

      .instruction-panel__title {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-tiny);
        font-weight: 500;
        color: var(--color-text-secondary);
      }

      .instruction-panel__title .codicon {
        font-size: var(--font-size-icon);
        line-height: 1;
      }

      .instruction-panel__actions {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
      }

      .instruction-panel__copy {
        opacity: 0.65;
      }

      :host(:hover) .instruction-panel__copy {
        opacity: 1;
      }

      .instruction-panel__body {
        padding: 0 var(--spacing-medium) var(--spacing-medium);
      }

      .instruction-panel__text {
        width: 100%;
        max-height: 12rem;
        font-family: var(--vscode-editor-font-family);
        font-size: var(--vscode-editor-font-size);
        line-height: 1.45;
      }

      .instruction-panel__text::part(control) {
        background-color: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
        border: 1px solid var(--vscode-input-border);
        padding: var(--spacing-small);
      }
    `,
  ];

  @property({ type: Object }) instruction: InstructionUpdate | null = null;
  @property({ type: Boolean, reflect: true }) visible = false;

  @query(`#${ELEMENT_IDS.INSTRUCTION_COPY_BTN}`)
  declare private copyButton: HTMLElement | null;

  override willUpdate(): void {
    this.visible = Boolean(this.instruction?.text?.trim());
  }

  render(): TemplateResult | typeof nothing {
    const text = this.instruction?.text ?? '';
    if (!text.trim()) {
      return nothing;
    }

    return html`
      <div id=${ELEMENT_IDS.INSTRUCTION_CONTAINER} class="instruction-panel">
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

  /** Handle copy button click - arrow function for correct `this` binding in Lit */
  private handleCopy = async (event: Event): Promise<void> => {
    event.preventDefault();
    const text = this.instruction?.text ?? '';
    if (!text.trim()) return;

    if (!this.copyButton) return;

    await copyWithFeedback(this.copyButton, text, {
      defaultTitle: this.copyButton.getAttribute('title') || 'Copy instruction',
      successTitle: 'Copied!',
    });
  };
}
