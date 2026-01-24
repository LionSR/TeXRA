// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

// Local imports - common
import { copyWithFeedback } from '@common/modules/clipboardUtils.js';

@customElement('instruction-panel')
export class InstructionPanel extends LitElement {
  @property({ type: String }) instruction: string | null = null;

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  private async handleCopy(event: Event) {
    event.preventDefault();
    const button = event.currentTarget as HTMLElement | null;
    const text = this.instruction ?? '';
    if (!button || !text.trim()) return;

    await copyWithFeedback(button, text, {
      defaultTitle:
        button.dataset.defaultTitle ||
        button.getAttribute('title') ||
        'Copy instruction',
      successTitle: button.dataset.successTitle || 'Copied!',
    });
  }

  override render() {
    const visible = Boolean(this.instruction?.trim());
    const classes = classMap({
      'instruction-panel': true,
      'is-visible': visible,
    });

    return html`
      <section
        class=${classes}
        id="instructionContainer"
        aria-hidden=${visible ? 'false' : 'true'}
      >
        <div class="instruction-panel__header">
          <div class="instruction-panel__title">
            <i class="codicon codicon-info"></i>
            Instruction
          </div>
          <div class="instruction-panel__actions">
            <vscode-button
              class="instruction-panel__copy"
              id="instructionCopyBtn"
              icon="copy"
              appearance="icon"
              data-default-title="Copy instruction"
              data-success-title="Copied!"
              title="Copy instruction"
              aria-label="Copy instruction"
              ?disabled=${!visible}
              @click=${this.handleCopy}
            ></vscode-button>
          </div>
        </div>
        <div class="instruction-panel__body">
          <vscode-text-area
            id="instructionText"
            class="instruction-panel__text"
            readonly
            .value=${this.instruction ?? ''}
          ></vscode-text-area>
        </div>
      </section>
    `;
  }
}
