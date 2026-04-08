/**
 * Banner explaining the orchestrator agent workflow.
 *
 * Appears when the orchestrator is selected in the agent dropdown
 * to help users understand the delegation-based workflow.
 * Dismissable — once hidden, stays hidden for the session.
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
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-small);
      }

      .orchestrator-banner-content {
        flex: 1;
        font-size: var(--font-size-sm);
      }

      .dismiss-btn {
        flex-shrink: 0;
        background: none;
        border: none;
        color: var(--color-text-secondary);
        cursor: pointer;
        padding: var(--spacing-tiny);
        border-radius: var(--border-radius);
        font-size: var(--font-size-sm);
      }

      .dismiss-btn:hover {
        color: var(--vscode-foreground);
      }

      .dismiss-btn:focus-visible {
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
        <div class="orchestrator-banner-content">
          <strong>Orchestrator selected.</strong> When you click Execute, it will
          analyze your paper and propose subtasks for specialized agents
          (correct, polish, draw, review, etc.). Each proposal appears in the
          Progress view for you to approve or adjust.
        </div>
        <button
          class="dismiss-btn"
          title="Dismiss"
          @click=${this.handleDismiss}
        >
          <span class="codicon codicon-close"></span>
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'orchestrator-banner': OrchestratorBanner;
  }
}
