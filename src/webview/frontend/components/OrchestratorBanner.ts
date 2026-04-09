/**
 * Banner explaining the orchestrator agent workflow.
 *
 * Appears when the orchestrator is selected in the agent dropdown
 * to help users understand the delegation-based workflow.
 * Dismissable via an explicit "Got it" button so users are more
 * likely to read it before dismissing.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, codiconStyles, commonViewStyles } from '@shared/styles';

// Local imports - shared utilities
import { createEvent } from '@shared/utils/events';

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
        padding: var(--spacing-medium);
        margin-bottom: var(--spacing-large);
        background-color: var(--vscode-inputValidation-infoBackground);
        color: var(--vscode-inputValidation-infoForeground);
        border: var(--border-thin) solid
          var(--vscode-inputValidation-infoBorder);
        line-height: var(--line-height-relaxed);
      }

      .orchestrator-banner-title {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-bold);
        margin-bottom: var(--spacing-small);
      }

      .orchestrator-steps {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-small);
        margin: var(--spacing-small) 0;
        padding: 0;
        list-style: none;
        font-size: var(--font-size-sm);
      }

      .orchestrator-step {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-small);
      }

      .step-icon {
        flex-shrink: 0;
        font-size: var(--font-size-sm);
        opacity: 0.8;
      }

      .orchestrator-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-small);
        margin-top: var(--spacing-small);
      }

      .orchestrator-link {
        font-size: var(--font-size-sm);
        color: var(--color-text-link);
        background: none;
        border: none;
        cursor: pointer;
        padding: 0;
        text-decoration: none;
      }

      .orchestrator-link:hover {
        text-decoration: underline;
      }

      .orchestrator-link:focus-visible {
        outline: var(--border-thin) solid var(--vscode-focusBorder);
        outline-offset: 1px;
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

  private handleOpenProgress(): void {
    this.dispatchEvent(createEvent('open-progress-view', {}));
  }

  private handleOpenMultiAgent(): void {
    this.dispatchEvent(createEvent('open-multi-agent-settings', {}));
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.visible || this.dismissed) return nothing;

    return html`
      <div class="orchestrator-banner">
        <div class="orchestrator-banner-title">Orchestrator selected</div>
        <ol class="orchestrator-steps">
          <li class="orchestrator-step">
            <span class="step-icon codicon codicon-play"></span>
            <span
              >Hit <strong>Execute</strong> -- the orchestrator reads your paper
              and figures out what needs work.</span
            >
          </li>
          <li class="orchestrator-step">
            <span class="step-icon codicon codicon-checklist"></span>
            <span
              >It proposes tasks in the
              <button
                class="orchestrator-link"
                @click=${this.handleOpenProgress}
              >
                Progress view
              </button>
              -- approve, edit, or reject each one.</span
            >
          </li>
          <li class="orchestrator-step">
            <span class="step-icon codicon codicon-rocket"></span>
            <span
              >Want it fully automatic? Turn on <strong>auto-approve</strong> in
              <button
                class="orchestrator-link"
                @click=${this.handleOpenMultiAgent}
              >
                Multi-Agent settings</button
              >.</span
            >
          </li>
        </ol>
        <div class="orchestrator-footer">
          <span style="font-size: var(--font-size-xs); opacity: 0.8"
            >Tip: Use keyboard shortcuts <strong>y</strong>/<strong>n</strong>
            to approve/reject proposals quickly.</span
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
