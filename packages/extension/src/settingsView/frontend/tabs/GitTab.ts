/** Git commit author + GitHub token + PR subscription settings. */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { UnsupportedCommandsMixin } from '@shared/wa/unsupportedCommandsMixin';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import {
  renderSetStatusIcon,
  statusCheckIconStyles,
} from '@shared/wa/statusIcons';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { renderSettingsSectionHeading } from '@shared/wa/settingsSection';

// Web Awesome icon bundle (side-effect import)
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/input/input.js';

// Local imports - shared schemas
import type { PRSubscriptionEntry } from '@shared/schemas/settingsViewMessages';

// Local imports - shared utils
import { isKnownUnsupported } from '@shared/utils/dispatcher';

// Local imports - shared constants
import {
  DEFAULT_GIT_AUTHOR_NAME,
  DEFAULT_GIT_AUTHOR_EMAIL,
} from '@shared/schemas/stateSettings';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

// Local imports - catalog-driven settings rows
import {
  postStateSetting,
  renderStateSettingToggleRow,
} from '../components/shared/stateSettingRows';
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';

@customElement('git-tab')
export class GitTab extends UnsupportedCommandsMixin(LitElement) {
  static override styles = [
    designTokens,
    commonViewStyles,
    statusCheckIconStyles,
    css`
      :host {
        display: block;
      }

      .git-container {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-xs);
      }

      .input-row {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        margin-top: var(--wa-space-2xs);
      }

      .input-row label {
        min-width: 80px;
        font-size: var(--font-size-sm);
      }

      .identity-fields {
        margin-top: var(--wa-space-xs);
        /* Rail-group the dependent fields under the controlling toggle so
           the enablement relationship reads as one region. */
        margin-inline-start: var(--wa-space-2xs);
        padding-inline-start: var(--wa-space-s);
        border-inline-start: var(--border-medium) solid var(--color-border);
      }

      .token-row {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        margin-top: var(--wa-space-2xs);
        flex-wrap: wrap;
      }

      .token-row-label {
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-normal);
      }

      .token-actions {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        flex-wrap: wrap;
      }

      .instructions {
        margin: var(--wa-space-2xs) 0 0 0;
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-quiet);
      }
      .instructions ol {
        margin: var(--wa-space-3xs) 0 0 0;
        padding-inline-start: 1.25em;
      }
      .instructions li {
        margin: var(--wa-space-3xs) 0;
      }
      .instructions code {
        background: var(--wa-color-surface-lowered);
        padding: 0 var(--wa-space-2xs);
        border-radius: var(--border-radius);
        font-size: var(--font-size-sm);
      }

      .subscriptions-list {
        list-style: none;
        padding: 0;
        margin: var(--wa-space-2xs) 0 0 0;
      }
      .subscriptions-list li {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: start;
        gap: var(--wa-space-2xs);
        padding: var(--wa-space-3xs) 0;
      }
      .subscriptions-list code {
        background: var(--wa-color-surface-lowered);
        padding: var(--border-thin) var(--wa-space-xs);
        border-radius: var(--border-radius);
        font-size: var(--font-size-sm);
      }
      .subscription-meta {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-2xs);
      }
      .subscription-key {
        overflow-wrap: anywhere;
      }
      .subscription-owners {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-3xs);
      }
      .subscription-owner-row {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        flex-wrap: wrap;
      }
      .subscription-owner-label,
      .subscription-owner-placeholder {
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-quiet);
      }
      .subscription-owner-placeholder {
        margin: 0;
      }
    `,
  ];

  @property({ attribute: false }) markCommits = false;
  @property({ attribute: false }) authorName = DEFAULT_GIT_AUTHOR_NAME;
  @property({ attribute: false }) authorEmail = DEFAULT_GIT_AUTHOR_EMAIL;
  @property({ attribute: false }) toggleDisabled = true;
  @property({ attribute: false }) githubTokenStatus: 'secret' | 'env' | 'none' =
    'none';
  @property({ attribute: false })
  prSubscriptions: readonly PRSubscriptionEntry[] = [];

  private handleAuthorNameChange(event: Event): void {
    const target = event.target as WaInput | null;
    const name = target?.value?.trim();
    if (name) {
      postStateSetting(WorkspaceStateKey.GIT_AUTHOR_NAME, name);
    }
  }

  private handleAuthorEmailChange(event: Event): void {
    const target = event.target as WaInput | null;
    const email = target?.value?.trim();
    if (email) {
      postStateSetting(WorkspaceStateKey.GIT_AUTHOR_EMAIL, email);
    }
  }

  private handleSetGitHubToken(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.SET_GITHUB_TOKEN);
  }

  private handleRemoveGitHubToken(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.REMOVE_GITHUB_TOKEN);
  }

  private handleOpenGitHubTokenUrl(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.OPEN_GITHUB_TOKEN_URL);
  }

  private handleUnsubscribePR(key: string): void {
    postMessage(SETTINGS_VIEW_COMMANDS.UNSUBSCRIBE_PR, { key });
  }

  private handleOpenPRSubscriptionStream(streamId: string): void {
    postMessage(SETTINGS_VIEW_COMMANDS.OPEN_PR_SUBSCRIPTION_STREAM, {
      streamId,
    });
  }

  private renderTokenStatusBadge(): TemplateResult {
    return renderSetStatusIcon({
      status: this.githubTokenStatus,
      title: 'Token set',
      fallbacks: {
        env: { label: 'Env', variant: 'neutral' },
        none: { label: 'Not set' },
      },
    });
  }

  override render(): TemplateResult {
    const tokenIsSet = this.githubTokenStatus !== 'none';
    return html`
      <div class="git-container tab-content-container">
        ${
          isKnownUnsupported(
            this.unsupportedCommands,
            SETTINGS_VIEW_COMMANDS.GET_GITHUB_TOKEN_STATUS,
          )
            ? nothing
            : html`
                <div class="settings-section">
                  ${renderSettingsSectionHeading({
                    title: 'GitHub personal access token',
                    description:
                      'Used to poll GitHub for pull request events, reviews, comments, and failed checks.',
                    icon: 'key',
                  })}
                  <div class="token-row">
                    <span class="token-row-label">Status:</span>
                    ${this.renderTokenStatusBadge()}
                    <span class="token-actions">
                      ${renderLabeledActionButton({
                        icon: 'key',
                        text: tokenIsSet ? 'Replace token' : 'Set token',
                        kind: 'secondary',
                        appearance: 'outlined',
                        onClick: this.handleSetGitHubToken,
                      })}
                      ${
                        this.githubTokenStatus === 'secret'
                          ? renderLabeledActionButton({
                              icon: 'trash',
                              text: 'Remove',
                              kind: 'danger',
                              onClick: this.handleRemoveGitHubToken,
                            })
                          : nothing
                      }
                      ${renderLabeledActionButton({
                        icon: 'arrow-up-right-from-square',
                        text: 'Create on GitHub…',
                        kind: 'secondary',
                        appearance: 'outlined',
                        onClick: this.handleOpenGitHubTokenUrl,
                      })}
                    </span>
                  </div>
                  <div class="instructions">
                    <strong>How to get a token:</strong>
                    <ol>
                      <li>
                        Click <em>Create on GitHub…</em> to open the
                        token-creation page in your browser.
                      </li>
                      <li>
                        Choose scopes: <code>repo</code> for private repos or
                        <code>public_repo</code> for public only. Read-only
                        usage; no write scopes needed.
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
                    ${
                      this.githubTokenStatus === 'env'
                        ? html`<p>
                            A token is currently being read from the
                            <code>GITHUB_TOKEN</code> or <code>GH_TOKEN</code>
                            environment variable. Setting one above will
                            override it.
                          </p>`
                        : nothing
                    }
                  </div>
                </div>
              `
        }
        ${
          !isKnownUnsupported(
            this.unsupportedCommands,
            SETTINGS_VIEW_COMMANDS.GET_PR_SUBSCRIPTIONS,
          ) && this.prSubscriptions.length > 0
            ? html`
                <div class="settings-section">
                  ${renderSettingsSectionHeading({
                    title: 'Active GitHub subscriptions',
                    description:
                      'Agents monitoring repositories, pull requests, or issues for new activity.',
                    icon: 'comments',
                  })}
                  <ul class="subscriptions-list">
                    ${this.prSubscriptions.map(
                      (subscription) => html`
                        <li>
                          <div class="subscription-meta">
                            <code class="subscription-key"
                              >${subscription.key}</code
                            >
                            ${
                              subscription.owners.length > 0
                                ? html`
                                    <div class="subscription-owners">
                                      ${subscription.owners.map(
                                        (owner) => html`
                                          <div class="subscription-owner-row">
                                            <span
                                              class="subscription-owner-label"
                                              >${owner.label}</span
                                            >
                                            ${renderLabeledActionButton({
                                              icon: 'comments',
                                              text: 'Jump to agent',
                                              kind: 'secondary',
                                              appearance: 'outlined',
                                              onClick: () =>
                                                this.handleOpenPRSubscriptionStream(
                                                  owner.streamId,
                                                ),
                                            })}
                                          </div>
                                        `,
                                      )}
                                    </div>
                                  `
                                : html`
                                    <p class="subscription-owner-placeholder">
                                      Started by an agent that is no longer
                                      active.
                                    </p>
                                  `
                            }
                          </div>
                          ${renderLabeledActionButton({
                            icon: 'circle-stop',
                            text: 'Stop',
                            kind: 'secondary',
                            appearance: 'outlined',
                            onClick: () =>
                              this.handleUnsubscribePR(subscription.key),
                          })}
                        </li>
                      `,
                    )}
                  </ul>
                </div>
              `
            : nothing
        }

        <div class="settings-section">
          ${renderSettingsSectionHeading({
            title: 'Agent commit attribution',
            description:
              'Keep agent-authored commits distinguishable from your personal Git identity.',
            icon: 'circle-dot',
          })}
          ${renderStateSettingToggleRow({
            key: WorkspaceStateKey.GIT_MARK_COMMITS,
            label: 'Mark TeXRA commits',
            description:
              'Use the TeXRA author identity for commits created by agents.',
            checked: this.markCommits,
            disabled: this.toggleDisabled,
          })}
          ${
            this.markCommits
              ? html`
                  <div class="identity-fields">
                    <div class="input-row">
                      <label for="git-author-name">Name</label>
                      <wa-input
                        id="git-author-name"
                        class="form-control-fill"
                        .value=${this.authorName}
                        placeholder=${DEFAULT_GIT_AUTHOR_NAME}
                        @change=${this.handleAuthorNameChange}
                      ></wa-input>
                    </div>
                    <div class="input-row">
                      <label for="git-author-email">Email</label>
                      <wa-input
                        id="git-author-email"
                        class="form-control-fill"
                        .value=${this.authorEmail}
                        placeholder=${DEFAULT_GIT_AUTHOR_EMAIL}
                        @change=${this.handleAuthorEmailChange}
                      ></wa-input>
                    </div>
                  </div>
                `
              : nothing
          }
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'git-tab': GitTab;
  }
}
