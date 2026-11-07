/** Bash command request card: "Run a command in `paper/`" and the command. */

// Third-party imports
import { html, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Local imports - progress view styles
import { codeBlockStyles } from '../styles/codeBlockStyles';

// Local imports - progress view formatters
import { buildCodeBlock } from '../formatters/htmlBuilders';

// Local imports - base class
import { BaseRequestPanel } from './BaseRequestPanel';

// Local imports - styles
import { bashRequestPanelStyles } from './BashRequestPanel.styles';

@customElement('bash-request-panel')
export class BashRequestPanel extends BaseRequestPanel<'bash'> {
  static override styles = [
    BaseRequestPanel.styles,
    codeBlockStyles,
    bashRequestPanelStyles,
  ];

  // The directory a command runs in is the security-relevant field of this
  // prompt, so it sits in the ask rather than in small print under it.
  protected override renderAsk(): TemplateResult {
    const { cwd } = this.permission.data;
    return cwd
      ? html`Run a command in <code><bdi dir="ltr">${cwd}</bdi></code>`
      : html`Run a command`;
  }

  override render(): TemplateResult {
    return this.renderCard(html`
      <div class="bash-request__command">
        ${buildCodeBlock(this.permission.data.command, {
          language: 'bash',
          className: 'tool-command-input',
          showLanguage: true,
          showCopy: true,
        })}
      </div>
    `);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'bash-request-panel': BashRequestPanel;
  }
}
