// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

@customElement('instruction-panel')
export class InstructionPanel extends LitElement {
  @property({ type: String }) text: string | null = null;
  @state() private copied = false;

  createRenderRoot(): HTMLElement {
    return this;
  }

  render(): TemplateResult {
    const hasText = Boolean(this.text && this.text.trim());
    return html`
      <section
        id="instructionContainer"
        class=${classMap({
          'instruction-panel': true,
          'is-visible': hasText,
        })}
      >
        <div class="instruction-panel__header">
          <div class="instruction-panel__title">
            <i class="codicon codicon-book"></i>
            Instruction
          </div>
          <div class="instruction-panel__actions">
            <vscode-toolbar-button
              id="instructionCopyBtn"
              class="instruction-panel__copy"
              icon="copy"
              title=${this.copied ? 'Copied!' : 'Copy instruction'}
              @click=${this.handleCopy}
            ></vscode-toolbar-button>
          </div>
        </div>
        <div class="instruction-panel__body">
          <vscode-textarea
            id="instructionText"
            class="instruction-panel__text"
            .value=${this.text ?? ''}
            readonly
          ></vscode-textarea>
        </div>
      </section>
    `;
  }

  private async handleCopy() {
    if (!this.text) return;
    await navigator.clipboard.writeText(this.text);
    this.copied = true;
    window.setTimeout(() => {
      this.copied = false;
    }, 1500);
  }
}
