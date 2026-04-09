/**
 * Banner explaining the orchestrator agent workflow.
 *
 * Appears when the orchestrator is selected in the agent dropdown
 * to help users understand the delegation-based workflow.
 * Dismissable via a "Got it" button.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, codiconStyles, commonViewStyles } from '@shared/styles';

@customElement('orchestrator-banner')
export class OrchestratorBanner extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .orchestrator-banner {
        border-radius: var(--border-radius);
        padding: var(--spacing-small) var(--spacing-medium);
        margin-bottom: var(--spacing-large);
        background-color: var(--vscode-inputValidation-infoBackground);
        color: var(--vscode-inputValidation-infoForeground);
        border: var(--border-thin) solid
          var(--vscode-inputValidation-infoBorder);
        line-height: var(--line-height-relaxed);
        font-size: var(--font-size-sm);
      }

      .orchestrator-banner-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: var(--spacing-small);
      }

      .orchestrator-tip {
        font-size: var(--font-size-xs);
        opacity: 0.8;
      }

      .got-it-btn {
        flex-shrink: 0;
        background: none;
        border: var(--border-thin) solid
          var(--vscode-inputValidation-infoBorder);
        color: var(--vscode-inputValidation-infoForeground);
        cursor: pointer;
        padding: var(--spacing-tiny) var(--spacing-medium);
        border-radius: var(--border-radius);
        font-size: var(--font-size-sm);
      }

      .got-it-btn:hover {
        background: color-mix(
          in srgb,
          var(--vscode-inputValidation-infoBorder) 15%,
          transparent
        );
      }

      .got-it-btn:focus-visible {
        outline: var(--border-thin) solid var(--vscode-focusBorder);
        outline-offset: 1px;
      }
    `,
  ];

  @property({ type: Boolean }) visible = false;
  @state() private dismissed = false;

  private handleDismiss(): void {
    this.dismissed = true;
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.visible || this.dismissed) return nothing;

    return html`
      <div class="orchestrator-banner">
        <strong>Orchestrator selected.</strong> Hit Execute and it will read
        your paper, figure out what needs work, and propose tasks for you to
        approve in the Progress view. Press <strong>y</strong>/<strong
          >n</strong
        >
        to approve or reject quickly.
        <div class="orchestrator-banner-footer">
          <span class="orchestrator-tip"
            >Configure auto-approve and presets in Multi-Agent settings.</span
          >
          <button class="got-it-btn" @click=${this.handleDismiss}>
            Got it
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'orchestrator-banner': OrchestratorBanner;
  }
}
