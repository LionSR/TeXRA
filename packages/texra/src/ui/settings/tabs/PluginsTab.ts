/**
 * Settings › Plugins: one row per thing that adds tools or agents, built once
 * by the host (`@texra/controllers/settingsView/pluginRows`). TeXRA's plugins carry
 * their setup and the inline settings their manifest declares (Codex and
 * Claude Code today); installed plugins their trust and actions; MCP servers
 * are listed read-only, edited in the file "Open mcp.json" opens.
 */

import { html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/select/select.js';

import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import { postToHost } from '@ui/settings/messageDispatcher';
import type { PluginRow } from '@texra/shared/settingsView/settingsViewMessages';
import {
  PLUGINS_PAGE,
  pluginRowKey,
  pluginRowName,
  pluginRowSummary,
  pluginRowState,
  pluginRowProblem,
} from '@ui/copy/plugins';
import { TexraSignalElement } from '@ui/litBase';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { renderLoadingState } from '@ui/wa/loadingState';

import { catalogDetailStyles } from '../components/shared/catalogDetailStyles';
import { type PluginsPageData } from '../settingsState';

import '../components/plugins/PluginCard';
import '../components/shared/SettingsCatalog';
import type { SettingsCatalogItem } from '../components/shared/SettingsCatalog';

@customElement('plugins-tab')
export class PluginsTab extends TexraSignalElement {
  static override styles = [
    TexraSignalElement.styles,
    catalogDetailStyles,
    css`
      :host {
        display: block;
      }

      .plugins-warnings {
        color: var(--color-error);
        font-size: var(--font-size-sm);
        margin: 0 0 var(--wa-space-xs);
        overflow-wrap: anywhere;
      }
    `,
  ];

  @state() private selectedKey: string | null = null;

  /** Null until the host's first rows arrive. */
  @property({ attribute: false }) page: PluginsPageData | null = null;

  private renderToolbar(): TemplateResult {
    return html`
      <div slot="actions" class="catalog-toolbar-actions">
        ${renderLabeledActionButton({
          icon: 'plus',
          text: PLUGINS_PAGE.add,
          kind: 'primary',
          onClick: () =>
            postToHost({
              command: SETTINGS_VIEW_COMMANDS.PLUGIN_ACTION,
              action: 'install',
            }),
        })}
      </div>
    `;
  }

  private catalogItems(rows: readonly PluginRow[]): SettingsCatalogItem[] {
    return rows.map((row) => ({
      key: pluginRowKey(row),
      name: pluginRowName(row),
      description:
        row.kind === 'texra' ? row.item.description : pluginRowSummary(row),
      group: { texra: 'TeXRA', installed: 'Installed', mcp: 'MCP servers' }[
        row.kind
      ],
      searchText: `${pluginRowSummary(row)} ${pluginRowProblem(row) ?? ''}`,
      control: html`<span class="catalog-row-status"
        >${pluginRowState(row)}</span
      >`,
    }));
  }

  private renderSelectedPlugin(
    rows: readonly PluginRow[],
  ): TemplateResult | typeof nothing {
    const row =
      rows.find((row) => pluginRowKey(row) === this.selectedKey) ?? rows[0];
    return row
      ? html`<plugin-card slot="detail" .row=${row}></plugin-card>`
      : nothing;
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
        ${
          page.mcpWarnings.length === 0
            ? nothing
            : html`<p class="plugins-warnings" role="status">
                ${page.mcpWarnings.join(' ')}
              </p>`
        }
        <settings-catalog
          label="Plugins"
          actionLabel="State"
          .items=${this.catalogItems(page.rows)}
          .selectedKey=${this.selectedKey}
          @catalog-select=${(event: CustomEvent<string | null>) => {
            this.selectedKey = event.detail;
          }}
        >
          ${this.renderToolbar()} ${this.renderSelectedPlugin(page.rows)}
        </settings-catalog>
        <div class="catalog-footer-actions">
          ${renderLabeledActionButton({
            icon: 'file-code',
            text: PLUGINS_PAGE.openMcpConfig,
            kind: 'secondary',
            onClick: () =>
              postToHost({
                command: SETTINGS_VIEW_COMMANDS.PLUGIN_ACTION,
                action: 'openMcpConfig',
              }),
          })}
          ${renderLabeledActionButton({
            icon: 'arrows-rotate',
            text: PLUGINS_PAGE.recheck,
            kind: 'secondary',
            onClick: () =>
              postToHost({
                command: SETTINGS_VIEW_COMMANDS.RECHECK_TOOL_STATUS,
              }),
          })}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'plugins-tab': PluginsTab;
  }
}
