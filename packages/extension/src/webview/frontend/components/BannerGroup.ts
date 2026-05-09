/** Container for MainView banners — passes state through to each banner component. */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared schemas
import type {
  AgentConfigBannerState,
  ApiKeyBannerState,
  DependencyBannerState,
} from '@shared/schemas';

// Side-effect imports to register banner custom elements
import './ApiKeyBanner';
import './AgentConfigBanner';
import './DependencyBanner';
import './GettingStartedBanner';
import './LoginBanner';

@customElement('banner-group')
export class BannerGroup extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
  `;

  @property({ attribute: false }) apiKeyBanner: ApiKeyBannerState = {
    visible: false,
  };

  @property({ attribute: false }) agentConfigBanner: AgentConfigBannerState = {
    visible: false,
  };

  @property({ attribute: false }) dependencyBanner: DependencyBannerState = {
    visible: false,
  };

  @property({ attribute: false }) gettingStartedVisible = false;

  @property({ attribute: false }) loginBannerVisible = false;

  override render(): TemplateResult {
    return html`
      <api-key-banner .state=${this.apiKeyBanner}></api-key-banner>
      <agent-config-banner
        .state=${this.agentConfigBanner}
      ></agent-config-banner>
      <dependency-banner .state=${this.dependencyBanner}></dependency-banner>
      <getting-started-banner
        .visible=${this.gettingStartedVisible}
      ></getting-started-banner>
      <login-banner .visible=${this.loginBannerVisible}></login-banner>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'banner-group': BannerGroup;
  }
}
