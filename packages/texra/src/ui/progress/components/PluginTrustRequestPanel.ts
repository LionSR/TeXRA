/** Plugin trust request card: "Trust and load the plugin echoes 1.0.0",
 *  whether it carries native code, where it is and what it contributes,
 *  then the whole review. */

// Third-party imports
import { css, html, nothing, type CSSResult, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Local imports - shared utilities
import { REQUEST_ASK } from '@ui/copy/requestCards';

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
    const { plugin, version } = this.permission.data;
    return html`${REQUEST_ASK.pluginTrust}
      <strong>${plugin}</strong>${version ? ` ${version}` : ''}`;
  }

  override render(): TemplateResult {
    const { path, digest, native, skills, programs, servers, review } =
      this.permission.data;
    const contributes = [
      native && `native code: ${native.provides.join(', ') || 'nothing'}`,
      `skills: ${skills}`,
      `programs: ${programs.join(', ') || 'none'}`,
      `MCP servers: ${servers.join(', ') || 'none'}`,
    ].filter(Boolean);
    return this.renderCard(html`
      ${
        native
          ? html`<div class="plugin-trust__native">
              ${REQUEST_ASK.nativeCode}
            </div>`
          : nothing
      }
      <div class="plugin-trust__facts">
        <div><bdi dir="ltr">${path}</bdi> (digest ${digest.slice(0, 12)})</div>
        <div>${contributes.join('; ')}</div>
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
