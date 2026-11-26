/** The identity agent commits carry. */

import { html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import {
  GIT_AUTHOR_EMAIL_SETTING,
  GIT_AUTHOR_NAME_SETTING,
  GIT_MARK_COMMITS_SETTING,
  type SettingRow,
} from '@texra-ai/worldline/schemas';
import WaInput from '@awesome.me/webawesome/dist/components/input/input.js';
import { TEXRA_SETTINGS } from '@texra/shared/settings/texraSettings';
import { renderSettingsSectionHeading } from '@ui/wa/settingsSection';
import { TexraSignalElement } from '@ui/litBase';

// Web Awesome icon bundle (side-effect import)
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - catalog-driven settings rows
import {
  postStateSetting,
  renderStateSettingToggleRow,
} from '../components/shared/stateSettingRows';
import { settingSignal } from '../settingsState';

/** The identity agent commits use while a field is blank: the default
 *  TeXRA's catalog gives the row (the harness names none). */
function defaultIdentity(row: SettingRow<string | undefined>): string {
  const value = TEXRA_SETTINGS.catalog.defaultOf(row.key);
  return typeof value === 'string' ? value : '';
}

const DEFAULT_GIT_AUTHOR_NAME = defaultIdentity(GIT_AUTHOR_NAME_SETTING);
const DEFAULT_GIT_AUTHOR_EMAIL = defaultIdentity(GIT_AUTHOR_EMAIL_SETTING);

@customElement('git-tab')
export class GitTab extends TexraSignalElement {
  static override styles = [
    TexraSignalElement.styles,
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
    `,
  ];

  @property({ attribute: false }) toggleDisabled = true;

  private handleIdentityInputChange(
    event: Event,
    row: SettingRow<string | undefined>,
  ): void {
    // An emptied field resets to the default identity its placeholder shows;
    // `null` clears the key (the catalog rejects a blank name or email).
    const value =
      event.target instanceof WaInput ? event.target.value?.trim() : undefined;
    postStateSetting(row.key, value || null);
  }

  override render(): TemplateResult {
    return html`
      <div class="git-container tab-content-container">
        <div class="settings-section">
          ${renderSettingsSectionHeading({
            title: 'Agent commit attribution',
            description:
              'Keep agent-authored commits distinguishable from your personal Git identity.',
            icon: 'circle-dot',
          })}
          ${renderStateSettingToggleRow(GIT_MARK_COMMITS_SETTING, {
            disabled: this.toggleDisabled,
          })}
          ${
            settingSignal(GIT_MARK_COMMITS_SETTING).get()
              ? html`
                  <div class="identity-fields">
                    <div class="input-row">
                      <label for="git-author-name">Name</label>
                      <wa-input
                        id="git-author-name"
                        class="form-control-fill"
                        name="git-author-name"
                        autocomplete="name"
                        spellcheck="false"
                        .value=${settingSignal(GIT_AUTHOR_NAME_SETTING).get() ?? ''}
                        placeholder=${DEFAULT_GIT_AUTHOR_NAME}
                        @change=${(event: Event) =>
                          this.handleIdentityInputChange(
                            event,
                            GIT_AUTHOR_NAME_SETTING,
                          )}
                      ></wa-input>
                    </div>
                    <div class="input-row">
                      <label for="git-author-email">Email</label>
                      <wa-input
                        id="git-author-email"
                        class="form-control-fill"
                        name="git-author-email"
                        type="email"
                        inputmode="email"
                        autocomplete="email"
                        autocapitalize="off"
                        spellcheck="false"
                        dir="ltr"
                        .value=${settingSignal(GIT_AUTHOR_EMAIL_SETTING).get() ?? ''}
                        placeholder=${DEFAULT_GIT_AUTHOR_EMAIL}
                        @change=${(event: Event) =>
                          this.handleIdentityInputChange(
                            event,
                            GIT_AUTHOR_EMAIL_SETTING,
                          )}
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
