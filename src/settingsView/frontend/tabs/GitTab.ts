/**
 * GitTab component — git commit author settings for the settings view.
 * Allows marking commits made by TeXRA with a custom author identity.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { codiconStyles, designTokens, commonViewStyles } from '@shared/styles';

// Local imports - shared utils
import { createEvent } from '@shared/utils/events';

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
    `,
  ];

  @property({ attribute: false }) markCommits = false;
  @property({ attribute: false }) authorName = 'TeXRA';
  @property({ attribute: false }) authorEmail = 'texra@users.noreply.github.com';
  @property({ attribute: false }) toggleDisabled = true;

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

  override render(): TemplateResult {
    return html`
      <div class="git-container">
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
                    placeholder="TeXRA"
                    @change=${this.handleAuthorNameChange}
                  ></vscode-textfield>
                </div>
                <div class="input-row">
                  <label>Email</label>
                  <vscode-textfield
                    .value=${this.authorEmail}
                    placeholder="texra@users.noreply.github.com"
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
          : ''}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'git-tab': GitTab;
  }
}
