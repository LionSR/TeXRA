/** Bash command approval request panel. */

// Third-party imports
import { html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

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

  protected override handleExtraKey(key: string): boolean {
    if (key === 'a') {
      return this.handleApproveSessionKey();
    }
    return false;
  }

  override render(): TemplateResult {
    const data = this.permission.data as BashPermission;

    return this.renderRequestShell({
      prefix: 'bash-approval-request',
      details: html`
        ${data.cwd
          ? html`<div class="bash-approval-request__cwd">
              Directory: <span>${data.cwd}</span>
            </div>`
          : ''}
        <div class="bash-approval-request__command">
          ${buildCodeBlock(data.command ?? '', { language: 'bash' })}
        </div>
      `,
      approveTitle: 'Allow this command to execute (y)',
      rejectTitle: 'Reject this command (n)',
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'bash-request-panel': BashRequestPanel;
  }
}
