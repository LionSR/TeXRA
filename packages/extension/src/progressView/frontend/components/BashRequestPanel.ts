/** Bash command approval request panel. */

// Third-party imports
import { html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared styles
import {
  commonViewStyles,
  designTokens,
  requestPanelStyles,
} from '@shared/styles';

// Local imports - progress view styles
import type { BashPermission } from '@shared/schemas';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { codeBlockStyles } from '../styles/codeBlockStyles';

// Local imports - progress view formatters
import { buildCodeBlock } from '../formatters/htmlBuilders';

// Local imports - base class
import { BaseFeedbackPanel } from './BaseFeedbackPanel';

// Local imports - shared schemas

@customElement('bash-request-panel')
export class BashRequestPanel extends BaseFeedbackPanel {
  static override styles = [
    designTokens,
    commonViewStyles,
    codeBlockStyles,
    requestPanelStyles,
  ];

  override render(): TemplateResult {
    const data = this.permission.data as BashPermission;

    return html`
      <div
        class=${classMap({
          'bash-approval-request': true,
          'bash-approval-request--feedback-active': this.showFeedback,
        })}
      >
        <div class="bash-approval-request__details">
          <div class="bash-approval-request__command">
            ${buildCodeBlock(data.command ?? '', { language: 'bash' })}
          </div>
        </div>
        <div class="bash-approval-request__actions">
          ${renderLabeledActionButton({
            icon: 'check',
            text: 'Approve',
            title: 'Allow this command to execute (y)',
            action: 'approve',
            onClick: () => this.emitAction('approve'),
          })}
          ${this.renderRejectButton('Reject this command (n)')}
        </div>
        ${this.renderFeedbackSection(
          'bash-approval-request__feedback',
          'bash-approval-request__feedback-input',
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'bash-request-panel': BashRequestPanel;
  }
}
