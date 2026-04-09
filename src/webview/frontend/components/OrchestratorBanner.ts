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

// Local imports
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';
import { designTokens, codiconStyles, commonViewStyles } from '@shared/styles';
import { postMessage } from '@shared/vscode';

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

      .settings-link {
        background: none;
        border: none;
        color: inherit;
        cursor: pointer;
        text-decoration: underline;
        padding: 0;
        font: inherit;
      }

      .settings-link:hover {
        opacity: 0.8;
      }
    `,
  ];

  @property({ type: Boolean }) visible = false;
  @state() private dismissed = false;

  private handleDismiss(): void {
    this.dismissed = true;
  }

  private handleOpenMultiAgentSettings(): void {
    postMessage(MAIN_VIEW_COMMANDS.OPEN_MULTI_AGENT_SETTINGS);
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.visible || this.dismissed) return nothing;

    return html`
      <div class="orchestrator-banner">
        <strong>Orchestrator selected.</strong> Hit Execute to analyze your
        paper and generate improvement tasks. Review and approve them in the
        Progress view — press <strong>y</strong>/<strong>n</strong> to approve
        or reject quickly.
        <div class="orchestrator-banner-footer">
          <span class="orchestrator-tip"
            >Customize auto-approve rules and task presets in
            <button
              class="settings-link"
              @click=${this.handleOpenMultiAgentSettings}
            >
              Multi-Agent settings</button
            >.</span
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
