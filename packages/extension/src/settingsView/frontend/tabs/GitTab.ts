/** Git commit author + GitHub token + PR subscription settings. */

import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import {
  renderSetStatusIcon,
  statusCheckIconStyles,
} from '@shared/wa/statusIcons';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Web Awesome icon bundle (side-effect import)
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';
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
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';
import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';

@customElement('git-tab')
export class GitTab extends LitElement {
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

      .setting-block {
        padding: var(--wa-space-xs);
        background-color: var(--wa-color-neutral-fill-quiet);
        border-radius: var(--border-radius);
      }

      .setting-description {
        margin: var(--wa-space-2xs) 0 0 0;
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-quiet);
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

      .input-row wa-input {
        flex: 1;
      }

      .section-title {
        font-weight: var(--font-weight-semibold);
        margin: 0;
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

      .token-remove-btn::part(base):hover {
        color: var(--wa-color-danger-on-quiet);
      }

      .instructions {
        margin: var(--wa-space-2xs) 0 0 0;
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-quiet);
      }
      .instructions ol {
        margin: var(--wa-space-3xs) 0 0 0;
        padding-left: 1.25em;
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

  /**
   * Commands the active host's registry declares `unsupported(...)`, sent
   * once at webview-ready (see `unsupportedCommands` in
   * `@shared/utils/dispatcher`). `null` before that broadcast arrives —
   * checked via `isKnownUnsupported`, which treats "not yet known" as
   * unsupported so a control never flashes visible then hidden.
   */
  @property({ attribute: false })
  unsupportedCommands: ReadonlySet<string> | null = null;

  private handleMarkCommitsToggle(event: Event): void {
    const target = event.target as WaSwitch | null;
    postMessage(SETTINGS_VIEW_COMMANDS.SET_GIT_MARK_COMMITS, {
      enabled: Boolean(target?.checked),
    });
  }

  private handleAuthorNameChange(event: Event): void {
    const target = event.target as WaInput | null;
    const name = target?.value?.trim();
    if (name) {
      postMessage(SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_NAME, { name });
    }
  }

  private handleAuthorEmailChange(event: Event): void {
    const target = event.target as WaInput | null;
    const email = target?.value?.trim();
    if (email) {
      postMessage(SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_EMAIL, { email });
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
        none: { label: 'Not set', variant: 'warning' },
      },
    });
  }

  override render(): TemplateResult {
    const tokenIsSet = this.githubTokenStatus !== 'none';
    return html`
      <div class="git-container">
        ${
          isKnownUnsupported(
            this.unsupportedCommands,
            SETTINGS_VIEW_COMMANDS.GET_GITHUB_TOKEN_STATUS,
          )
            ? nothing
            : html`
                <div class="setting-block">
                  <p class="section-title">GitHub personal access token</p>
                  <p class="setting-description">
                    Used to poll GitHub for pull request events (comments,
                    reviews, failed CI) when you subscribe to a PR.
                  </p>
                  <div class="token-row">
                    <span class="token-row-label">Status:</span>
                    ${this.renderTokenStatusBadge()}
                    <span class="token-actions">
                      <wa-button
                        appearance="outlined"
                        variant="neutral"
                        size="small"
                        @click=${this.handleSetGitHubToken}
                      >
                        ${waIcon('key', { slot: 'start' })}
                        ${tokenIsSet ? 'Replace token' : 'Set token'}
                      </wa-button>
                      ${
                        this.githubTokenStatus === 'secret'
                          ? html`<wa-button
                              class="token-remove-btn"
                              appearance="outlined"
                              variant="neutral"
                              size="small"
                              @click=${this.handleRemoveGitHubToken}
                            >
                              ${waIcon('trash', { slot: 'start' })} Remove
                            </wa-button>`
                          : nothing
                      }
                      <wa-button
                        appearance="outlined"
                        variant="neutral"
                        size="small"
                        @click=${this.handleOpenGitHubTokenUrl}
                      >
                        ${waIcon('github', { slot: 'start' })} Create on GitHub…
                      </wa-button>
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
                <div class="setting-block">
                  <p class="section-title">Active GitHub subscriptions</p>
                  <p class="setting-description">
                    An agent is monitoring these repositories
                    (<code>owner/repo</code>), pull requests
                    (<code>owner/repo/pulls/N</code>), or issues
                    (<code>owner/repo/issues/N</code>) in the background,
                    polling GitHub every ~30 seconds. New comments, reviews, and
                    CI failures arrive as follow-up messages in the agent's
                    conversation so it can investigate and act on them. PR
                    subscriptions end automatically on close/merge; issue
                    subscriptions stay active across close so reopens are
                    caught. All kinds detach after 24 hours of continuous
                    network failure. Click <em>Stop</em> to cancel one manually.
                  </p>
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
                                            <wa-button
                                              appearance="outlined"
                                              variant="neutral"
                                              size="small"
                                              @click=${() =>
                                                this.handleOpenPRSubscriptionStream(
                                                  owner.streamId,
                                                )}
                                            >
                                              ${waIcon('comment-discussion', {
                                                slot: 'start',
                                              })}
                                              Jump to agent
                                            </wa-button>
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
                          <wa-button
                            appearance="outlined"
                            variant="neutral"
                            size="small"
                            @click=${() =>
                              this.handleUnsubscribePR(subscription.key)}
                          >
                            ${waIcon('debug-stop', { slot: 'start' })} Stop
                          </wa-button>
                        </li>
                      `,
                    )}
                  </ul>
                </div>
              `
            : nothing
        }

        <div class="setting-block">
          <wa-switch
            ?checked=${this.markCommits}
            ?disabled=${this.toggleDisabled}
            @change=${this.handleMarkCommitsToggle}
          >
            Mark commits with TeXRA author info
          </wa-switch>
          <p class="setting-description">
            When enabled, commits made by TeXRA agents are attributed to a
            custom author identity instead of your personal git config.
          </p>
        </div>

        ${
          this.markCommits
            ? html`
                <div class="setting-block">
                  <div class="input-row">
                    <label>Name</label>
                    <wa-input
                      .value=${this.authorName}
                      placeholder=${DEFAULT_GIT_AUTHOR_NAME}
                      @change=${this.handleAuthorNameChange}
                    ></wa-input>
                  </div>
                  <div class="input-row">
                    <label>Email</label>
                    <wa-input
                      .value=${this.authorEmail}
                      placeholder=${DEFAULT_GIT_AUTHOR_EMAIL}
                      @change=${this.handleAuthorEmailChange}
                    ></wa-input>
                  </div>
                  <p class="setting-description">
                    These values are set as GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL,
                    GIT_COMMITTER_NAME, and GIT_COMMITTER_EMAIL for all commands
                    run by TeXRA.
                  </p>
                </div>
              `
            : nothing
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'git-tab': GitTab;
  }
}
