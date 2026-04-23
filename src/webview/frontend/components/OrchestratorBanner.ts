/**
 * Banner with orchestrator-specific tips.
 *
 * Appears when the orchestrator is selected. The conceptual explanation
 * lives in the InstructionPanel's session-hint; this banner adds only
 * complementary info: the approval keyboard shortcut and a shortcut
 * to Multi-Agent settings. Dismissable via the shared notice control.
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
import { infoNoticeStyles } from '../styles/infoNoticeStyles';
import { renderInfoNotice } from './infoNotice';

@customElement('orchestrator-banner')
export class OrchestratorBanner extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    infoNoticeStyles,
    css`
      .orchestrator-tip {
        font-size: var(--font-size-xs);
        opacity: 0.8;
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

    return renderInfoNotice({
      ariaLabel: 'Orchestrator approval guidance',
      variant: 'banner',
      content: html`
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
      `,
      dismiss: {
        title: 'Dismiss (can be re-enabled in settings)',
        ariaLabel: 'Dismiss orchestrator banner',
        onDismiss: this.handleDismiss,
      },
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'orchestrator-banner': OrchestratorBanner;
  }
}
