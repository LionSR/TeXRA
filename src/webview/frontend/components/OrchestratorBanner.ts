/**
 * Banner with orchestrator-specific tips.
 *
 * Appears when the orchestrator is selected. The conceptual explanation
 * lives in the InstructionPanel's session-hint; this banner adds only
 * complementary info: the approval keyboard shortcut and a shortcut
 * to Multi-Agent settings. Dismissable via "Got it".
 *
 * @fires dismiss-orchestrator - When dismiss button is clicked
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';
import { designTokens, codiconStyles, commonViewStyles } from '@shared/styles';
import { postMessage } from '@shared/vscode';

// Local imports - main view events
import { MainViewEvents } from '../events';

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
        justify-content: flex-end;
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

  private handleDismiss(): void {
    this.dispatchEvent(MainViewEvents.dismissOrchestrator());
  }

  private handleOpenMultiAgentSettings(): void {
    postMessage(MAIN_VIEW_COMMANDS.OPEN_MULTI_AGENT_SETTINGS);
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.visible) return nothing;

    return html`
      <div class="orchestrator-banner">
        <span class="orchestrator-tip">
          <strong>Not sure which agent?</strong> Just ask — type something
          like "which agent should handle my intro?" and the orchestrator will
          pick and dispatch the right one for you.
        </span>
        <span class="orchestrator-tip">
          <strong>Tip:</strong> press <strong>y</strong>/<strong>n</strong> in
          the Progress board to approve or reject proposed tasks fast. Tune
          auto-approve rules and presets in
          <button
            class="settings-link"
            @click=${this.handleOpenMultiAgentSettings}
          >
            Multi-Agent settings</button
          >.
        </span>
        <div class="orchestrator-banner-footer">
          <button
            class="got-it-btn"
            title="Dismiss (can be re-enabled in settings)"
            @click=${this.handleDismiss}
          >
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
