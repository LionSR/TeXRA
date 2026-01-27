/**
 * BannerGroup component for MainView banners.
 *
 * Renders various notification banners (API key, agent config,
 * dependency, getting started, login).
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { when } from 'lit/directives/when.js';

// Local imports - main view
import { MainViewEvents } from '../events';

// Local imports - shared utilities
import { COMMAND_LINKS } from '@shared/utils/uiConstants';

// Local imports - shared schemas
import type {
  AgentConfigBannerState,
  ApiKeyBannerState,
  DependencyBannerState,
} from '@shared/schemas';

@customElement('banner-group')
export class BannerGroup extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }

    .api-key-banner,
    .agent-config-banner,
    .dependency-banner,
    .getting-started-banner {
      border-radius: var(--border-radius);
      padding: var(--spacing-small) var(--spacing-medium);
      margin-bottom: var(--spacing-large);
    }

    .api-key-banner,
    .agent-config-banner,
    .dependency-banner {
      background-color: var(--vscode-inputValidation-warningBackground);
      color: var(--vscode-inputValidation-warningForeground);
      border: 1px solid var(--vscode-inputValidation-warningBorder);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .getting-started-banner {
      background-color: var(--vscode-inputValidation-infoBackground);
      color: var(--vscode-inputValidation-infoForeground);
      border: 1px solid var(--vscode-inputValidation-infoBorder);
      line-height: 1.5;
    }

    .getting-started-banner a {
      color: var(--color-text-link);
      text-decoration: none;
    }

    .getting-started-banner a:hover {
      text-decoration: underline;
    }

    .actions {
      display: flex;
      align-items: center;
      gap: var(--spacing-small);
    }

    .dependency-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--spacing-small);
    }

    .missing-tools {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-tiny);
    }

    .login-banner {
      background: linear-gradient(
        135deg,
        var(--vscode-inputValidation-infoBackground) 0%,
        color-mix(
            in srgb,
            var(--vscode-inputValidation-infoBackground) 80%,
            var(--vscode-button-background)
          )
          100%
      );
      color: var(--vscode-inputValidation-infoForeground);
      border: 1px solid var(--vscode-inputValidation-infoBorder);
      border-radius: var(--border-radius);
      padding: var(--spacing-medium);
      margin-bottom: var(--spacing-large);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--spacing-medium);
    }

    .login-banner-content {
      display: flex;
      align-items: center;
      gap: var(--spacing-medium);
      flex: 1;
    }

    .login-banner-icon {
      font-size: 1.5em;
      color: var(--vscode-button-background);
      display: flex;
      align-items: center;
    }

    .login-banner-text {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-tiny);
    }

    .login-banner-title {
      font-weight: 600;
      font-size: 1em;
    }

    .login-banner-description {
      font-size: 0.9em;
      opacity: 0.9;
    }

    .login-banner .actions {
      flex-shrink: 0;
    }
  `;

  /** API key banner state */
  @property({ type: Object }) apiKeyBanner: ApiKeyBannerState = {
    visible: false,
  };

  /** Agent config banner state */
  @property({ type: Object }) agentConfigBanner: AgentConfigBannerState = {
    visible: false,
  };

  /** Dependency banner state */
  @property({ type: Object }) dependencyBanner: DependencyBannerState = {
    visible: false,
  };

  /** Getting started banner visibility */
  @property({ type: Boolean }) gettingStartedVisible = false;

  /** Login banner visibility */
  @property({ type: Boolean }) loginBannerVisible = false;

  private handleApiKeyAction(action: 'set' | 'guide'): void {
    this.dispatchEvent(
      MainViewEvents.apiKeyAction({
        action,
        provider: this.apiKeyBanner.provider,
      }),
    );
  }

  private handleAgentConfigAction(action: 'edit' | 'dir' | 'docs'): void {
    this.dispatchEvent(
      MainViewEvents.agentConfigAction({
        action,
        customDirSet: this.agentConfigBanner.customDirSet,
      }),
    );
  }

  private handleDependencyDismiss(): void {
    this.dispatchEvent(MainViewEvents.dependencyDismiss());
  }

  private handleRecheckDependencies(): void {
    this.dispatchEvent(MainViewEvents.recheckDependencies());
  }

  private handleOpenInstallGuide(tool: string): void {
    this.dispatchEvent(MainViewEvents.openInstallGuide({ tool }));
  }

  private handleSignIn(): void {
    this.dispatchEvent(MainViewEvents.signIn());
  }

  private handleDismissLogin(): void {
    this.dispatchEvent(MainViewEvents.dismissLogin());
  }

  private renderApiKeyBanner(): TemplateResult | typeof nothing {
    if (!this.apiKeyBanner.visible) return nothing;

    const providerLabel = this.apiKeyBanner.provider
      ? `${this.apiKeyBanner.provider.charAt(0).toUpperCase()}${this.apiKeyBanner.provider.slice(1)}`
      : '';

    return html`
      <div id="apiKeyBanner" class="api-key-banner">
        <span>
          ${this.apiKeyBanner.provider
            ? html`<strong>${providerLabel}</strong> API key missing.`
            : 'TeXRA requires an API key to run.'}
        </span>
        <div class="actions">
          <vscode-toolbar-button
            id="apiKeyBannerButton"
            icon="key"
            @click=${() => this.handleApiKeyAction('set')}
          >
            ${this.apiKeyBanner.provider ? 'Set Key' : 'Set API Key'}
          </vscode-toolbar-button>
          <vscode-toolbar-button
            id="apiKeyGuideButton"
            icon="book"
            @click=${() => this.handleApiKeyAction('guide')}
          >
            ${this.apiKeyBanner.provider ? 'Get Key' : 'API Key Guide'}
          </vscode-toolbar-button>
        </div>
      </div>
    `;
  }

  private renderAgentConfigBanner(): TemplateResult | typeof nothing {
    if (!this.agentConfigBanner.visible) return nothing;

    return html`
      <div
        id="agentConfigBanner"
        class="agent-config-banner"
        data-custom-dir-set=${this.agentConfigBanner.customDirSet
          ? 'true'
          : 'false'}
      >
        <span>
          ${this.agentConfigBanner.agentName
            ? `Agent file for "${this.agentConfigBanner.agentName}" is missing.`
            : 'Agent configuration is missing.'}
        </span>
        <div class="actions">
          <vscode-toolbar-button
            id="agentConfigEditButton"
            icon="edit"
            @click=${() => this.handleAgentConfigAction('edit')}
          >
            Edit Agents
          </vscode-toolbar-button>
          <vscode-toolbar-button
            id="agentConfigDirButton"
            icon="folder"
            @click=${() => this.handleAgentConfigAction('dir')}
          >
            ${this.agentConfigBanner.customDirSet
              ? 'Open Directory'
              : 'Set Directory'}
          </vscode-toolbar-button>
          <vscode-toolbar-button
            id="agentConfigDocButton"
            icon="book"
            @click=${() => this.handleAgentConfigAction('docs')}
          >
            Docs
          </vscode-toolbar-button>
        </div>
      </div>
    `;
  }

  private renderDependencyBanner(): TemplateResult | typeof nothing {
    if (!this.dependencyBanner.visible) return nothing;

    const missing = this.dependencyBanner.missingTools ?? [];
    const tools = missing.flatMap((tool) =>
      tool === 'gm/magick' ? ['gm', 'magick'] : [tool],
    );

    return html`
      <div id="dependencyBanner" class="dependency-banner">
        <span class="missing-tools">
          ${when(
            tools.length === 0,
            () => html`Missing dependencies: none`,
            () =>
              repeat(
                tools,
                (tool) => tool,
                (tool) => {
                  const label =
                    tool === 'gm'
                      ? 'GraphicsMagick'
                      : tool === 'magick'
                        ? 'ImageMagick'
                        : tool;
                  return html`
                    <div class="dependency-item">
                      <span>${label}</span>
                      <vscode-toolbar-button
                        class="btn-secondary dependency-install-button"
                        icon="cloud-download"
                        @click=${() => this.handleOpenInstallGuide(tool)}
                      >
                        Install
                      </vscode-toolbar-button>
                    </div>
                  `;
                },
              ),
          )}
        </span>
        <div class="actions">
          <vscode-toolbar-button
            id="dependencyRecheckButton"
            icon="refresh"
            @click=${this.handleRecheckDependencies}
          >
            Re-check
          </vscode-toolbar-button>
          <vscode-toolbar-button
            id="dependencyDismissButton"
            class="btn-secondary"
            title="Dismiss (can be re-enabled in settings)"
            icon="close"
            @click=${this.handleDependencyDismiss}
          >
            Dismiss
          </vscode-toolbar-button>
        </div>
      </div>
    `;
  }

  private renderGettingStartedBanner(): TemplateResult | typeof nothing {
    if (!this.gettingStartedVisible) return nothing;

    return html`
      <div id="gettingStartedBanner" class="getting-started-banner">
        <span class="getting-started-text">
          No files found in workspace. Try
          <a href=${COMMAND_LINKS.GETTING_STARTED}
            >opening the getting started walkthrough</a
          >,
          <a href=${COMMAND_LINKS.CREATE_SAMPLE_PROJECT}
            >creating a sample project</a
          >,
          <a href=${COMMAND_LINKS.CLONE_OVERLEAF}>cloning an Overleaf project</a
          >, or
          <a href=${COMMAND_LINKS.DOWNLOAD_ARXIV}>downloading an arXiv source</a
          >.
        </span>
      </div>
    `;
  }

  private renderLoginBanner(): TemplateResult | typeof nothing {
    if (!this.loginBannerVisible) return nothing;

    return html`
      <div id="loginBanner" class="login-banner">
        <div class="login-banner-content">
          <span class="login-banner-icon"
            ><i class="codicon codicon-sparkle"></i
          ></span>
          <div class="login-banner-text">
            <span class="login-banner-title">Researcher Access Program</span>
            <span class="login-banner-description">
              Sign in to access AI models and remote agents without your own API
              keys.
            </span>
          </div>
        </div>
        <div class="actions">
          <vscode-button
            id="loginBannerButton"
            appearance="primary"
            @click=${this.handleSignIn}
          >
            <span slot="start" class="codicon codicon-sign-in"></span>
            Sign In
          </vscode-button>
          <vscode-toolbar-button
            id="loginBannerDismissButton"
            icon="close"
            title="Dismiss (can be re-enabled in settings)"
            aria-label="Dismiss login banner"
            @click=${this.handleDismissLogin}
          ></vscode-toolbar-button>
        </div>
      </div>
    `;
  }

  override render(): TemplateResult {
    return html`
      ${this.renderApiKeyBanner()} ${this.renderAgentConfigBanner()}
      ${this.renderDependencyBanner()} ${this.renderGettingStartedBanner()}
      ${this.renderLoginBanner()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'banner-group': BannerGroup;
  }
}
