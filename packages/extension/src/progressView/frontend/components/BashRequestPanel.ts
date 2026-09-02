/** Bash command approval request panel. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared styles
import {
  commonViewStyles,
  designTokens,
  requestPanelSharedStyles,
} from '@shared/styles';

// Local imports - progress view styles
import { codeBlockStyles } from '../styles/codeBlockStyles';

// Local imports - progress view formatters
import { buildCodeBlock } from '../formatters/htmlBuilders';

// Local imports - base class
import { BaseBypassApprovalPanel } from './BaseBypassApprovalPanel';

// Local imports - styles
import { bashRequestPanelStyles } from './BashRequestPanel.styles';

@customElement('bash-request-panel')
export class BashRequestPanel extends BaseBypassApprovalPanel<'bash'> {
  static override styles = [
    designTokens,
    commonViewStyles,
    codeBlockStyles,
    requestPanelSharedStyles,
    bashRequestPanelStyles,
  ];

  protected readonly approvalDecision = { action: 'approve' } as const;

  override render(): TemplateResult {
    const data = this.permission.data;

    return this.renderRequestShell({
      prefix: 'bash-approval-request',
      details: html`
        ${
          data.cwd
            ? html`<div class="bash-approval-request__cwd">
                Runs in: <bdi dir="ltr">${data.cwd}</bdi>
              </div>`
            : nothing
        }
        <div class="bash-approval-request__command">
          ${buildCodeBlock(data.command, {
            language: 'bash',
            className: 'tool-command-input',
            showLanguage: true,
            showCopy: true,
          })}
        </div>
      `,
      approveTitle: 'Run this command (y)',
      rejectTitle: 'Do not run this command (n)',
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'bash-request-panel': BashRequestPanel;
  }
}
