/**
 * GitTab component — git commit author settings for the settings view.
 * Allows marking commits made by TeXRA with a custom author identity.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { codiconStyles, designTokens, commonViewStyles } from '@shared/styles';

// Local imports - shared utils
import { createEvent } from '@shared/utils/events';

// Local imports - shared constants
import {
  DEFAULT_GIT_AUTHOR_NAME,
  DEFAULT_GIT_AUTHOR_EMAIL,
} from '@shared/constants/git';

@customElement('git-tab')
export class GitTab extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .git-container {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-medium);
      }

      .setting-block {
        padding: var(--spacing-medium);
        background-color: var(--vscode-editor-inactiveSelectionBackground);
        border-radius: var(--border-radius);
      }

      .setting-description {
        margin: var(--spacing-small) 0 0 0;
        font-size: var(--font-size-sm);
        color: var(--vscode-descriptionForeground);
      }

      .input-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        margin-top: var(--spacing-small);
      }

      .input-row label {
        min-width: 80px;
        font-size: var(--font-size-sm);
      }

      .input-row vscode-textfield {
        flex: 1;
      }

      .section-title {
        font-weight: 600;
        margin: 0;
      }

      .token-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        margin-top: var(--spacing-small);
        flex-wrap: wrap;
      }

      .badge {
        padding: 2px 8px;
        border-radius: 10px;
        font-size: var(--font-size-xs);
        font-weight: 600;
      }
      .badge-ok {
        background: var(--vscode-testing-iconPassed, #16825d);
        color: var(--vscode-editor-background);
      }
      .badge-info {
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
      }
      .badge-warn {
        background: var(--vscode-editorWarning-foreground, #cca700);
        color: var(--vscode-editor-background);
      }

      .instructions {
        margin: var(--spacing-small) 0 0 0;
        font-size: var(--font-size-sm);
        color: var(--vscode-descriptionForeground);
      }
      .instructions ol {
        margin: var(--spacing-xs) 0 0 0;
        padding-left: 1.25em;
      }
      .instructions li {
        margin: 2px 0;
      }
      .instructions code {
        background: var(--vscode-textBlockQuote-background);
        padding: 0 4px;
        border-radius: 3px;
        font-size: 0.9em;
      }
    `,
  ];

  @property({ attribute: false }) markCommits = false;
  @property({ attribute: false }) authorName = DEFAULT_GIT_AUTHOR_NAME;
  @property({ attribute: false }) authorEmail = DEFAULT_GIT_AUTHOR_EMAIL;
  @property({ attribute: false }) toggleDisabled = true;
  @property({ attribute: false }) githubTokenStatus: 'secret' | 'env' | 'none' =
    'none';

  private handleMarkCommitsToggle(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.dispatchEvent(
      createEvent('git-mark-commits-toggle', {
        enabled: Boolean(target?.checked),
      }),
    );
  }

  private handleAuthorNameChange(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    const name = target?.value?.trim();
    if (name) {
      this.dispatchEvent(createEvent('git-author-name-change', { name }));
    }
  }

  private handleAuthorEmailChange(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    const email = target?.value?.trim();
    if (email) {
      this.dispatchEvent(createEvent('git-author-email-change', { email }));
    }
  }

  private handleSetGitHubToken(): void {
    this.dispatchEvent(createEvent('github-token-set', {}));
  }

  private handleRemoveGitHubToken(): void {
    this.dispatchEvent(createEvent('github-token-remove', {}));
  }

  private handleOpenGitHubTokenUrl(): void {
    this.dispatchEvent(createEvent('github-token-open-url', {}));
  }

  private renderTokenStatusBadge(): TemplateResult {
    if (this.githubTokenStatus === 'secret') {
      return html`<span class="badge badge-ok">Set</span>`;
    }
    if (this.githubTokenStatus === 'env') {
      return html`<span class="badge badge-info">Env</span>`;
    }
    return html`<span class="badge badge-warn">Not set</span>`;
  }

  override render(): TemplateResult {
    const tokenIsSet = this.githubTokenStatus !== 'none';
    return html`
      <div class="git-container">
        <div class="setting-block">
          <p class="section-title">GitHub personal access token</p>
          <p class="setting-description">
            Used by the <code>subscribe_pr_activity</code> tool to poll
            GitHub for pull request events (comments, reviews, failed CI).
            Stored in VS Code SecretStorage — never written to
            <code>settings.json</code>.
          </p>
          <div class="token-row">
            Status: ${this.renderTokenStatusBadge()}
            <vscode-button
              appearance="primary"
              @click=${this.handleSetGitHubToken}
            >
              ${tokenIsSet ? 'Replace token' : 'Set token'}
            </vscode-button>
            ${this.githubTokenStatus === 'secret'
              ? html`<vscode-button
                  appearance="secondary"
                  @click=${this.handleRemoveGitHubToken}
                  >Remove</vscode-button
                >`
              : nothing}
            <vscode-button
              appearance="secondary"
              @click=${this.handleOpenGitHubTokenUrl}
              >Create on GitHub…</vscode-button
            >
          </div>
          <div class="instructions">
            <strong>How to get a token:</strong>
            <ol>
              <li>
                Click <em>Create on GitHub…</em> (opens the token-creation
                page in your browser, pre-filled for TeXRA PR subscription
                use).
              </li>
              <li>
                Choose scopes: <code>repo</code> for private repos or
                <code>public_repo</code> for public only. Read-only usage;
                no write scopes needed.
              </li>
              <li>
                Pick an expiration (90 days is common) and click
                <em>Generate token</em>.
              </li>
              <li>
                Copy the token (shown only once) and paste it here via
                <em>Set token</em>.
              </li>
            </ol>
            ${this.githubTokenStatus === 'env'
              ? html`<p>
                  A token is currently being read from the
                  <code>GITHUB_TOKEN</code> environment variable. Setting
                  one above will override it.
                </p>`
              : nothing}
          </div>
        </div>

        <div class="setting-block">
          <vscode-checkbox
            ?checked=${this.markCommits}
            ?disabled=${this.toggleDisabled}
            @change=${this.handleMarkCommitsToggle}
          >
            Mark commits with TeXRA author info
          </vscode-checkbox>
          <p class="setting-description">
            When enabled, commits made by TeXRA agents are attributed to a
            custom author identity instead of your personal git config.
          </p>
        </div>

        ${this.markCommits
          ? html`
              <div class="setting-block">
                <div class="input-row">
                  <label>Name</label>
                  <vscode-textfield
                    .value=${this.authorName}
                    placeholder=${DEFAULT_GIT_AUTHOR_NAME}
                    @change=${this.handleAuthorNameChange}
                  ></vscode-textfield>
                </div>
                <div class="input-row">
                  <label>Email</label>
                  <vscode-textfield
                    .value=${this.authorEmail}
                    placeholder=${DEFAULT_GIT_AUTHOR_EMAIL}
                    @change=${this.handleAuthorEmailChange}
                  ></vscode-textfield>
                </div>
                <p class="setting-description">
                  These values are set as GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL,
                  GIT_COMMITTER_NAME, and GIT_COMMITTER_EMAIL for all commands
                  run by TeXRA.
                </p>
              </div>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'git-tab': GitTab;
  }
}
