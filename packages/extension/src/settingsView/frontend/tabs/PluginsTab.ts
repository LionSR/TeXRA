/**
 * Settings › Plugins: one row per thing that adds tools or agents, built once
 * by the host (`@controllers/settingsView/pluginRows`). TeXRA's plugins carry
 * their setup and the inline settings their manifest declares (Codex and
 * Claude Code today); installed plugins their trust and actions; MCP servers
 * are listed read-only, edited in the file "Open mcp.json" opens.
 */

import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/select/select.js';

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import type { PluginRow } from '@shared/settingsView/settingsViewMessages';
import { TEXRA_SETTINGS } from '@shared/settingsView/texraSettings';
import { PLUGINS_PAGE, pluginRowKey } from '@ui/copy/plugins';
import { commonViewStyles, designTokens } from '@ui/styles';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { renderEmptyState } from '@ui/wa/emptyState';
import { renderLoadingState } from '@ui/wa/loadingState';
import { readSelectValue } from '@ui/wa/selectTemplates';

import {
  catalogEnumChoices,
  postStateSetting,
} from '../components/shared/stateSettingRows';
import type { PluginsPageData } from '../settingsState';

import '../components/plugins/PluginCard';

@customElement('plugins-tab')
export class PluginsTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .plugins-toolbar {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        flex-wrap: wrap;
        gap: var(--wa-space-xs);
        margin-bottom: var(--wa-space-xs);
      }

      .plugins-warnings {
        color: var(--wa-color-danger-text);
        font-size: var(--font-size-sm);
        margin: 0 0 var(--wa-space-xs);
        overflow-wrap: anywhere;
      }

      .setting-select {
        min-width: 10rem;
        max-width: 14rem;
      }
    `,
  ];

  /** Null until the host's first rows arrive. */
  @property({ attribute: false }) page: PluginsPageData | null = null;
  /** Current value of every inline setting the rows declare, by catalog
   *  key; `SettingsApp` reads them from the keyed setting signals. */
  @property({ attribute: false }) settingValues: Readonly<
    Record<string, string>
  > = {};

  /**
   * One catalog-backed select row: the allowed values, their labels, and the
   * help text all come from the `stateSettings` entry for `key`, and the
   * change handler writes that same key. Only the row label is passed in:
   * inside a plugin card it reads bare ('Reasoning effort') where the
   * catalog title has to disambiguate in a flat list.
   */
  private renderSelectRow(
    label: string,
    key: string,
    value: string,
  ): TemplateResult {
    const entry = TEXRA_SETTINGS.settingsViewByKey(key);
    if (!entry) {
      throw new Error(`No settings-view catalog row for setting "${key}"`);
    }
    const options = catalogEnumChoices(key);
    if (options.length === 0) {
      throw new Error(`Inline setting "${key}" is not an enum catalog row`);
    }
    const controlId = `plugin-setting-${key.replaceAll('.', '-')}`;
    return html`
      <div class="settings-row">
        <div class="settings-row-text">
          <label class="settings-row-label" for=${controlId}>${label}</label>
          <span class="settings-row-help">${entry.description}</span>
        </div>
        <div class="settings-row-control">
          <wa-select
            class="setting-select"
            id=${controlId}
            .value=${value}
            @change=${(e: Event) => {
              const selected = readSelectValue(e);
              if (selected) postStateSetting(key, selected);
            }}
          >
            ${options.map(
              (opt) => html`
                <wa-option value=${opt.value}>${opt.label}</wa-option>
              `,
            )}
          </wa-select>
        </div>
      </div>
    `;
  }

  private renderRowSettings(row: PluginRow): TemplateResult | typeof nothing {
    if (row.kind !== 'texra' || !row.item.settings?.length) return nothing;
    return html`
      <div slot="details" class="settings-section">
        ${row.item.settings.map(([key, label]) =>
          this.renderSelectRow(label, key, this.settingValues[key]),
        )}
      </div>
    `;
  }

  private renderToolbar(): TemplateResult {
    return html`
      <div class="plugins-toolbar">
        ${renderLabeledActionButton({
          icon: 'plus',
          text: PLUGINS_PAGE.add,
          kind: 'primary',
          onClick: () =>
            postMessage(SETTINGS_VIEW_COMMANDS.PLUGIN_ACTION, {
              action: 'install',
            }),
        })}
        ${renderLabeledActionButton({
          icon: 'file-code',
          text: PLUGINS_PAGE.openMcpConfig,
          kind: 'secondary',
          appearance: 'outlined',
          onClick: () =>
            postMessage(SETTINGS_VIEW_COMMANDS.PLUGIN_ACTION, {
              action: 'openMcpConfig',
            }),
        })}
        ${renderLabeledActionButton({
          icon: 'rotate-right',
          text: PLUGINS_PAGE.recheck,
          kind: 'secondary',
          appearance: 'outlined',
          onClick: () =>
            postMessage(SETTINGS_VIEW_COMMANDS.RECHECK_TOOL_STATUS),
        })}
      </div>
    `;
  }

  override render(): TemplateResult {
    const { page } = this;
    if (page === null) {
      return html`
        <div class="tab-content-container">
          ${renderLoadingState(PLUGINS_PAGE.loading)}
        </div>
      `;
    }
    return html`
      <div class="tab-content-container">
        ${this.renderToolbar()}
        ${
          page.mcpWarnings.length === 0
            ? nothing
            : html`<p class="plugins-warnings" role="status">
                ${page.mcpWarnings.join(' ')}
              </p>`
        }
        ${
          page.rows.length === 0
            ? renderEmptyState({
                icon: 'cube',
                title: PLUGINS_PAGE.empty,
                headingTag: 'h3',
                className: 'empty-state',
              })
            : repeat(
                page.rows,
                pluginRowKey,
                (row) => html`
                  <plugin-card .row=${row}>
                    ${this.renderRowSettings(row)}
                  </plugin-card>
                `,
              )
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'plugins-tab': PluginsTab;
  }
}
