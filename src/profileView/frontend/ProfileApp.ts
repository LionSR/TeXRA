// Third-party imports
import { html, css, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';

// Local imports - shared webview
import { BaseWebviewApp } from '@shared/BaseWebviewApp';
import { postMessage } from '@shared/vscode';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';

// Local imports - shared schemas
import { UpdateProfileMessageSchema, type RemoteAgent } from '@shared/schemas';

// Local imports - profile view commands
import { PROFILE_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - profile view components
import './components/ProfileInfo';
import './components/ApiAccessSection';
import './components/AgentsTable';
import './components/SignInPrompt';

// Local imports - profile view styles
import { profileViewStyles } from './styles';

@customElement('profile-app')
export class ProfileApp extends BaseWebviewApp {
  static styles = [
    designTokens,
    commonViewStyles,
    profileViewStyles,
    css`
      :host {
        display: block;
      }
    `,
  ];

  @state() private authenticated = false;
  @state() private userEmail = '';
  @state() private userId = '';
  @state() private tier = 'free';
  @state() private remoteAgents: RemoteAgent[] = [];
  @state() private apiAccessMode: 'included' | 'personal' = 'personal';
  @state() private enabledProviders: string[] = [];
  @state() private allowedModels: string[] | null = [];
  @state() private accessExpiresAt: string | null = null;

  protected get readyCommand(): string | null {
    return null;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    postMessage(PROFILE_VIEW_COMMANDS.GET_PROFILE_DATA);
  }

  protected handleMessage(raw: unknown): void {
    const result = UpdateProfileMessageSchema.safeParse(raw);
    if (!result.success) {
      this.logSchemaError(
        '[ProfileApp] Update profile message validation failed.',
        result.error,
      );
      return;
    }

    const data = result.data;
    this.authenticated = data.authenticated;
    this.userEmail = data.user?.email ?? 'N/A';
    this.userId = data.user?.id ?? '';
    this.tier = data.tier ?? 'free';
    this.remoteAgents = data.remoteAgents ?? [];
    this.apiAccessMode = data.apiAccessMode;
    this.enabledProviders = data.enabledProviders ?? [];
    this.allowedModels = data.allowedModels ?? null;
    this.accessExpiresAt = data.accessExpiresAt ?? null;
  }

  private handleSignIn = (): void => {
    postMessage(PROFILE_VIEW_COMMANDS.SIGN_IN);
  };

  private handleSelectAgent = (
    event: CustomEvent<{ agentName: string }>,
  ): void => {
    postMessage(PROFILE_VIEW_COMMANDS.SELECT_AGENT, {
      agentName: event.detail.agentName,
    });
  };

  private handleApiAccessMode = (
    event: CustomEvent<{ mode: 'included' | 'personal' }>,
  ): void => {
    postMessage(PROFILE_VIEW_COMMANDS.SET_API_ACCESS_MODE, {
      mode: event.detail.mode,
    });
  };

  render(): TemplateResult {
    return html`
      <div class="profile-container">
        <header class="view-header">
          <h1>TeXRA Account</h1>
        </header>

        ${this.authenticated
          ? html`
              <profile-info
                .email=${this.userEmail}
                .userId=${this.userId}
                .tier=${this.tier}
                .accessExpiresAt=${this.accessExpiresAt}
              ></profile-info>

              <api-access-section
                .mode=${this.apiAccessMode}
                .enabledProviders=${this.enabledProviders}
                .allowedModels=${this.allowedModels}
                @profile-api-access-mode=${this.handleApiAccessMode}
              ></api-access-section>

              <section class="remote-agents-section">
                <h2>Available Remote Agents</h2>
                ${this.remoteAgents.length
                  ? html`
                      <agents-table
                        .agents=${this.remoteAgents}
                        @profile-select-agent=${this.handleSelectAgent}
                      ></agents-table>
                    `
                  : html`
                      <p class="no-agents">
                        No remote agents available. Contact support@texra.ai for
                        assistance.
                      </p>
                    `}
              </section>
            `
          : html`<sign-in-prompt
              @profile-sign-in=${this.handleSignIn}
            ></sign-in-prompt>`}
      </div>
    `;
  }
}
