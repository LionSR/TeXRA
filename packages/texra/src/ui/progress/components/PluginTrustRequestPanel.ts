/** Plugin trust request card: "Trust and load the plugin echoes 1.0.0",
 *  whether it carries native code, where it is, then the whole review. */

// Third-party imports
import { css, html, nothing, type CSSResult, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Local imports - shared utilities
import { pluginTrustFacts, REQUEST_ASK } from '@ui/copy/requestCards';

// Local imports - base class
import { BaseRequestPanel } from './BaseRequestPanel';

const pluginTrustRequestPanelStyles: CSSResult = css`
  .plugin-trust__native {
    margin: var(--wa-space-2xs) 0;
    color: var(--wa-color-warning-on-quiet);
    font-weight: var(--wa-font-weight-semibold);
  }

  .plugin-trust__facts {
    margin: var(--wa-space-2xs) 0;
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    overflow-wrap: anywhere;
  }

  .plugin-trust__review {
    margin: var(--wa-space-2xs) 0 0;
    font-family: var(--wa-font-family-mono);
    font-size: var(--font-size-sm);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
`;

@customElement('plugin-trust-request-panel')
export class PluginTrustRequestPanel extends BaseRequestPanel<'pluginTrust'> {
  static override styles = [
    BaseRequestPanel.styles,
    pluginTrustRequestPanelStyles,
  ];

  protected override renderAsk(): TemplateResult {
    return html`${REQUEST_ASK.pluginTrust}
      <strong>${pluginTrustFacts(this.permission.data).plugin}</strong>`;
  }

  override render(): TemplateResult {
    const { native, review } = this.permission.data;
    return this.renderCard(html`
      ${
        native
          ? html`<div class="plugin-trust__native">
              ${REQUEST_ASK.nativeCode}
            </div>`
          : nothing
      }
      <div class="plugin-trust__facts">
        <bdi dir="ltr">${pluginTrustFacts(this.permission.data).location}</bdi>
      </div>
      <div class="plugin-trust__review">${review.join('\n')}</div>
    `);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'plugin-trust-request-panel': PluginTrustRequestPanel;
  }
}
