/**
 * One row of the Plugins page: what it is and adds, its one switch, its
 * trust, whether it can run here with the fix when it cannot, and the agents
 * that use it. Every word comes from the row copy (`@ui/copy/plugins`).
 */

import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import {
  LitElement,
  html,
  css,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@texra/shared/hostBridge';
import { toolDependencyStatusLabel } from '@texra/shared/tools/toolDependencyStatusLabels';
import type { PluginActionMessage } from '@texra/shared/settingsView/pluginMessages';
import type {
  PluginRow,
  ToolCommandKind,
  ToolDashboardItem,
  ToolInstallAction,
} from '@texra/shared/settingsView/settingsViewMessages';
import { DetailsOpenController } from '@texra/shared/litControllers/DetailsOpenController';
import {
  PLUGINS_PAGE,
  pluginRowName,
  pluginRowProblem,
  pluginRowSummary,
  pluginRowSwitchable,
  pluginRowTrust,
  pluginRowUsedBy,
} from '@ui/copy/plugins';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { renderSettingsToggleRow } from '@ui/wa/settingsSection';
import { renderStatusBadge } from '@ui/wa/statusIcons';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import { commonViewStyles, designTokens } from '@ui/styles';
import { catalogDetailStyles } from '../shared/catalogDetailStyles';
import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';

type TexraRow = Extract<PluginRow, { kind: 'texra' }>;

@customElement('plugin-card')
export class PluginCard extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    catalogDetailStyles,
    css`
      :host {
        display: block;
      }

      .plugin-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: var(--wa-space-xs);
        margin-bottom: var(--wa-space-2xs);
      }

      .plugin-summary {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        column-gap: var(--wa-space-xs);
        row-gap: var(--wa-space-2xs);
        min-width: 0;
        margin-block-end: var(--wa-space-2xs);
      }

      .plugin-summary > .plugin-line {
        margin: 0;
      }

      .plugin-ready {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        color: var(--color-status-ok);
        font-size: var(--font-size-sm);
      }

      wa-tag.plugin-badge {
        white-space: nowrap;
      }

      .plugin-line {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        margin: 0 0 var(--wa-space-2xs);
        line-height: var(--line-height-normal);
        overflow-wrap: anywhere;
      }

      .plugin-tools {
        display: flex;
        flex-wrap: wrap;
        gap: var(--wa-space-2xs);
        padding: 0;
        margin: 0 0 var(--wa-space-2xs);
        list-style: none;
      }

      .plugin-guide {
        margin-top: var(--wa-space-2xs);
        padding-block: var(--wa-space-xs);
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-normal);
        line-height: var(--line-height-relaxed);
        white-space: pre-wrap;
      }

      .plugin-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--wa-space-2xs);
        margin-top: var(--wa-space-2xs);
      }

      .plugin-auth-note {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        padding: var(--border-thin) var(--wa-space-2xs);
        font-size: var(--font-size-xs);
        border-radius: var(--border-radius);
        font-weight: var(--font-weight-medium);
        color: var(--color-info);
        background: color-mix(in srgb, var(--color-info) 12%, transparent);
        overflow-wrap: anywhere;
      }

      .plugin-note {
        margin-top: var(--wa-space-2xs);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        overflow-wrap: anywhere;
      }
    `,
  ];

  @property({ attribute: false }) row!: PluginRow;

  private readonly guideDetails = new DetailsOpenController(this);

  /** Reveal the setup buttons as soon as a plugin first reports missing. */
  override willUpdate(changed: PropertyValues<this>): void {
    if (!changed.has('row') || this.row.kind !== 'texra') return;
    const prev = changed.get('row');
    const was = prev?.kind === 'texra' ? prev.item.status : undefined;
    if (prev?.kind !== 'texra' || prev.item.id !== this.row.item.id) {
      this.guideDetails.open = this.row.item.status === 'not-found';
    } else if (was !== 'not-found' && this.row.item.status === 'not-found') {
      this.guideDetails.open = true;
    }
  }

  private runCommand(item: ToolDashboardItem, kind: ToolCommandKind): void {
    postMessage(SETTINGS_VIEW_COMMANDS.RUN_TOOL_COMMAND, {
      toolId: item.id,
      kind,
    });
  }

  private pluginAction(action: PluginActionMessage['action']): void {
    if (this.row.kind !== 'installed') return;
    postMessage(SETTINGS_VIEW_COMMANDS.PLUGIN_ACTION, {
      action,
      name: this.row.plugin.name,
    });
  }

  private renderInstallAction(
    item: ToolDashboardItem,
    action: ToolInstallAction,
    secondaryAppearance: 'filled' | 'outlined',
    secondaryVariant: 'brand' | 'neutral',
  ): TemplateResult | typeof nothing {
    switch (action.kind) {
      case 'guide':
        return nothing;
      case 'command':
        return html`
          <wa-button
            id="plugin-install-btn-${item.id}"
            appearance="filled"
            variant="brand"
            size="s"
            @click=${() => this.runCommand(item, 'install')}
          >
            ${waIcon('terminal', { slot: 'start' })}
            ${PLUGINS_PAGE.installInTerminal}
          </wa-button>
          <wa-tooltip for="plugin-install-btn-${item.id}"
            >${action.command}</wa-tooltip
          >
        `;
      case 'auth':
        return html`
          <wa-button
            id="plugin-auth-btn-${item.id}"
            appearance=${secondaryAppearance}
            variant=${secondaryVariant}
            size="s"
            @click=${() => this.runCommand(item, 'auth')}
          >
            ${waIcon('right-to-bracket', { slot: 'start' })}
            ${PLUGINS_PAGE.signIn}
          </wa-button>
          <wa-tooltip for="plugin-auth-btn-${item.id}"
            >${action.command}</wa-tooltip
          >
        `;
      case 'extension':
        return html`
          <wa-button
            appearance="filled"
            variant="brand"
            size="s"
            @click=${() =>
              postMessage(SETTINGS_VIEW_COMMANDS.INSTALL_TOOL_EXTENSION, {
                extensionId: action.extensionId,
              })}
          >
            ${waIcon('cloud-arrow-down', { slot: 'start' })}
            ${PLUGINS_PAGE.installExtension}
          </wa-button>
        `;
      case 'url':
        return html`
          <wa-button
            appearance=${secondaryAppearance}
            variant=${secondaryVariant}
            size="s"
            @click=${() =>
              postMessage(SETTINGS_VIEW_COMMANDS.OPEN_EXTERNAL_URL, {
                url: action.url,
              })}
          >
            ${waIcon('arrow-up-right-from-square', { slot: 'start' })}
            ${PLUGINS_PAGE.openInstallPage}
          </wa-button>
        `;
    }
  }

  /** A TeXRA plugin's setup: its guide and the actions that fix it. */
  private renderSetup(
    item: ToolDashboardItem,
  ): TemplateResult | typeof nothing {
    if (
      !item.requiresSetup ||
      item.installActions.every((action) => action.kind === 'extension')
    ) {
      return nothing;
    }

    // When a primary install action exists (terminal command or extension
    // marketplace), demote auxiliary buttons (Sign in, Open install page)
    // to secondary styling.
    const hasPrimaryInstallAction = item.installActions.some(
      (action) => action.kind === 'command' || action.kind === 'extension',
    );
    const secondaryAppearance = hasPrimaryInstallAction ? 'outlined' : 'filled';
    const secondaryVariant = hasPrimaryInstallAction ? 'neutral' : 'brand';

    return html`
      <wa-details
        class="collapsible-quiet plugin-guide-details"
        summary=${PLUGINS_PAGE.setUp(item.name)}
        ?open=${this.guideDetails.open}
        @wa-show=${this.guideDetails.handleShow}
        @wa-hide=${this.guideDetails.handleHide}
      >
        ${item.installActions.map((action) =>
          action.kind === 'guide'
            ? html`<div class="plugin-guide">${action.text}</div>`
            : nothing,
        )}
        <div class="plugin-actions">
          ${item.installActions.map((action) =>
            this.renderInstallAction(
              item,
              action,
              secondaryAppearance,
              secondaryVariant,
            ),
          )}
        </div>
        ${
          item.configNotes
            ? html`<div class="plugin-note">${item.configNotes}</div>`
            : nothing
        }
      </wa-details>
    `;
  }

  /** An installed plugin's actions: review its trust, update, remove. */
  private renderInstalledActions(
    row: Extract<PluginRow, { kind: 'installed' }>,
  ): TemplateResult {
    const { plugin } = row;
    return html`
      <div class="plugin-actions">
        ${
          plugin.enabled && !plugin.trusted
            ? renderLabeledActionButton({
                icon: 'shield',
                text: PLUGINS_PAGE.review,
                kind: 'secondary',
                appearance: 'outlined',
                onClick: () => this.pluginAction('enable'),
              })
            : nothing
        }
        ${renderLabeledActionButton({
          icon: 'rotate-right',
          text: PLUGINS_PAGE.update,
          kind: 'secondary',
          appearance: 'outlined',
          onClick: () => this.pluginAction('update'),
        })}
        ${renderLabeledActionButton({
          icon: 'trash',
          text: PLUGINS_PAGE.remove,
          kind: 'secondary',
          appearance: 'outlined',
          onClick: () => this.pluginAction('remove'),
        })}
      </div>
    `;
  }

  /** A probed TeXRA plugin that can run here says so: the result a
   *  Re-check is waiting for. */
  private renderReady(): TemplateResult | typeof nothing {
    const { row } = this;
    if (row.kind !== 'texra' || !row.item.requiresSetup) return nothing;
    const label = toolDependencyStatusLabel(
      row.item.status,
      row.item.statusLabel,
    );
    return html`<span class="plugin-ready">${waIcon('check')}${label}</span>`;
  }

  /** The row's one switch, or none for a row that is always on or read-only. */
  private renderSwitch(): TemplateResult | typeof nothing {
    const { row } = this;
    let checked: boolean;
    let disabled = false;
    let onChange: (on: boolean) => void;
    if (row.kind === 'texra') {
      if (row.item.toggleable !== true)
        return html`<p class="plugin-line">Always available to agents</p>`;
      const { id } = row.item;
      checked = row.item.enabled !== false;
      onChange = (enabled) =>
        postMessage(SETTINGS_VIEW_COMMANDS.TOGGLE_TOOL, {
          toolId: id,
          enabled,
        });
    } else if (row.kind === 'installed') {
      checked = row.plugin.enabled;
      disabled = !pluginRowSwitchable(row);
      // Switching on asks the host to show what it declares and trust it.
      onChange = (on) => this.pluginAction(on ? 'enable' : 'disable');
    } else {
      return nothing;
    }
    return renderSettingsToggleRow({
      label: PLUGINS_PAGE.availableToAgents,
      checked,
      disabled,
      onChange: (event: Event) =>
        onChange(Boolean((event.currentTarget as WaSwitch | null)?.checked)),
    });
  }

  private renderTools(
    item: ToolDashboardItem,
  ): TemplateResult | typeof nothing {
    if (item.tools.length === 0) return nothing;
    return html`
      <ul class="plugin-tools" aria-label=${PLUGINS_PAGE.toolsItAdds}>
        ${item.tools.map(
          (tool) =>
            html`<li>
              <wa-tag
                class="catalog-tool-badge"
                variant="neutral"
                appearance="filled"
                size="s"
                ><bdi dir="auto">${tool.name}</bdi></wa-tag
              >
            </li>`,
        )}
      </ul>
    `;
  }

  private renderTexraBody(row: TexraRow): TemplateResult {
    const { item } = row;
    return html`
      <p class="catalog-detail-description" dir="auto">${item.description}</p>
      ${
        item.statusDetail
          ? html`<div class="plugin-note" dir="auto">${item.statusDetail}</div>`
          : nothing
      }
      ${this.renderTools(item)}
    `;
  }

  override render(): TemplateResult {
    const { row } = this;
    const problem = pluginRowProblem(row);
    const trust = pluginRowTrust(row);
    const usedBy = pluginRowUsedBy(row);
    const authNote = row.kind === 'texra' ? row.item.authNote : undefined;

    return html`
      <article class="plugin-card" data-plugin-kind=${row.kind}>
        <div class="plugin-header">
          <h3 class="catalog-detail-name">
            <bdi dir="auto">${pluginRowName(row)}</bdi>
          </h3>
        </div>
        <div class="plugin-summary">
          <p class="plugin-line">
            ${pluginRowSummary(row)}${trust ? ` · ${trust}` : ''}
          </p>
          ${
            problem
              ? renderStatusBadge({
                  icon: waIcon('triangle-exclamation'),
                  label: problem,
                  className: 'plugin-badge',
                })
              : this.renderReady()
          }
          ${
            authNote
              ? html`<span class="plugin-auth-note"
                  >${waIcon('key')} <bdi dir="auto">${authNote}</bdi></span
                >`
              : nothing
          }
        </div>
        ${this.renderSwitch()}
        ${row.kind === 'texra' ? this.renderTexraBody(row) : nothing}
        ${
          row.kind === 'installed'
            ? html`<p class="plugin-line">
                <code>${row.plugin.source}</code>
              </p>`
            : nothing
        }
        ${usedBy ? html`<p class="plugin-line">${usedBy}</p>` : nothing}
        <slot name="details"></slot>
        ${row.kind === 'texra' ? this.renderSetup(row.item) : nothing}
        ${row.kind === 'installed' ? this.renderInstalledActions(row) : nothing}
      </article>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'plugin-card': PluginCard;
  }
}
