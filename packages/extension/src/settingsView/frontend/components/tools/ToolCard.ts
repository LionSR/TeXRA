/** Single tool group with status, description, and optional installation guide. */

import '@awesome.me/webawesome/dist/components/badge/badge.js';
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
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';

// Local imports - shared webview
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import type {
  ToolCommandKind,
  ToolDashboardItem,
  ToolInstallAction,
} from '@shared/schemas';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Local imports - shared schemas
import { toolStatusLabel } from '@shared/tools/toolStatusLabels';
import type WaSwitch from '@awesome.me/webawesome/dist/components/switch/switch.js';

@customElement('tool-card')
export class ToolCard extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .tool-card {
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--border-radius);
        padding: var(--wa-space-xs) var(--wa-space-s);
        margin-bottom: var(--wa-space-xs);
        background: var(
          --wa-color-surface-default,
          var(--wa-color-surface-lowered)
        );
      }

      .tool-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: var(--wa-space-xs);
        margin-bottom: var(--wa-space-2xs);
      }

      .tool-title-group {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--wa-space-2xs);
        min-width: 0;
      }

      .tool-name {
        font-weight: var(--font-weight-medium);
        font-size: var(--font-size);
        color: var(--wa-color-text-normal);
        margin: 0;
        overflow-wrap: anywhere;
      }

      wa-tag.tool-badge {
        white-space: nowrap;
      }

      .tool-status-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        flex: 0 0 18px;
        color: var(--color-status-ok);
      }

      .tool-status-icon wa-icon {
        font-size: var(--font-size-sm);
      }

      .tool-description {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        margin-top: 0;
        margin-bottom: var(--wa-space-2xs);
        line-height: var(--line-height-normal);
        overflow-wrap: anywhere;
      }

      .tool-ids {
        display: flex;
        flex-wrap: wrap;
        gap: var(--wa-space-2xs);
        padding: 0;
        margin: 0 0 var(--wa-space-2xs);
        list-style: none;
      }

      .tool-id {
        min-width: 0;
      }

      wa-badge.tool-id-tag::part(base) {
        font-family: var(--wa-font-family-mono, monospace), monospace;
        font-size: var(--font-size-xs);
        overflow-wrap: anywhere;
      }

      .tool-guide {
        margin-top: var(--wa-space-2xs);
        padding: var(--wa-space-xs);
        background: var(--wa-color-surface-lowered);
        border-radius: var(--border-radius);
        font-size: var(--font-size-sm);
        color: var(--wa-color-text-normal);
        line-height: var(--line-height-relaxed);
        white-space: pre-wrap;
      }

      .tool-guide-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--wa-space-2xs);
        margin-top: var(--wa-space-2xs);
      }

      .tool-guide-actions wa-button::part(base) {
        min-height: var(--height-control);
      }

      .tool-auth-note {
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

      .tool-toggle {
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
        margin-inline-start: auto;
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
      }

      @container settings (max-width: 520px) {
        .tool-header {
          align-items: flex-start;
        }

        .tool-toggle {
          width: 100%;
          margin-inline-start: 0;
        }
      }

      .tool-config-note {
        margin-top: var(--wa-space-2xs);
        font-size: var(--font-size-xs);
        color: var(--color-text-secondary);
        overflow-wrap: anywhere;
      }
    `,
  ];

  @property({ attribute: false }) item!: ToolDashboardItem;

  @state() private guideExpanded = false;

  /** Reveal the install buttons immediately when a tool first reports missing. */
  override willUpdate(changed: PropertyValues<this>): void {
    if (!changed.has('item')) return;
    const prev = changed.get('item');
    if (prev?.status !== 'not-found' && this.item.status === 'not-found') {
      this.guideExpanded = true;
    }
  }

  private handleGuideShow(event: Event): void {
    if (event.target !== event.currentTarget) return;
    this.guideExpanded = true;
  }

  private handleGuideHide(event: Event): void {
    if (event.target !== event.currentTarget) return;
    this.guideExpanded = false;
  }

  private runCommand(kind: ToolCommandKind): void {
    postMessage(SETTINGS_VIEW_COMMANDS.RUN_TOOL_COMMAND, {
      toolId: this.item.id,
      kind,
    });
  }

  private handleToggle(e: Event): void {
    const target = e.currentTarget as WaSwitch | null;
    postMessage(SETTINGS_VIEW_COMMANDS.TOGGLE_TOOL, {
      toolId: this.item.id,
      enabled: Boolean(target?.checked),
    });
  }

  private static readonly STATUS_ICON: Record<
    ToolDashboardItem['status'],
    TeXRAIconName
  > = {
    available: 'check',
    'not-found': 'triangle-exclamation',
    unknown: 'circle-question',
    'coming-soon': 'clock',
  };

  private renderAvailableStatusIcon(): TemplateResult {
    const label = toolStatusLabel(this.item.status, this.item.statusLabel);

    return html`
      <span
        class="tool-status-icon"
        role="img"
        aria-label=${label}
        title=${label}
      >
        ${waIcon(ToolCard.STATUS_ICON.available)}
      </span>
    `;
  }

  // Only the non-available statuses reach this badge (see `render`), and they
  // all read neutral; the icon carries the distinction.
  private renderStatusBadge(): TemplateResult {
    const { status } = this.item;
    const label = toolStatusLabel(status, this.item.statusLabel);

    return html`
      <wa-tag class="tool-badge" variant="neutral" size="s">
        ${waIcon(ToolCard.STATUS_ICON[status])} ${label}
      </wa-tag>
    `;
  }

  private renderInstallAction(
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
            id="tool-install-btn-${this.item.id}"
            appearance="filled"
            variant="brand"
            size="s"
            @click=${() => this.runCommand('install')}
          >
            ${waIcon('terminal', { slot: 'start' })} Install in terminal
          </wa-button>
          <wa-tooltip for="tool-install-btn-${this.item.id}"
            >${action.command}</wa-tooltip
          >
        `;
      case 'auth':
        return html`
          <wa-button
            id="tool-auth-btn-${this.item.id}"
            appearance=${secondaryAppearance}
            variant=${secondaryVariant}
            size="s"
            @click=${() => this.runCommand('auth')}
          >
            ${waIcon('right-to-bracket', { slot: 'start' })} Sign in
          </wa-button>
          <wa-tooltip for="tool-auth-btn-${this.item.id}"
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
            ${waIcon('cloud-arrow-down', { slot: 'start' })} Install extension
          </wa-button>
        `;
      case 'url':
        return html`
          <wa-button
            appearance=${secondaryAppearance}
            variant=${secondaryVariant}
            size="s"
            @click=${() =>
              postMessage(SETTINGS_VIEW_COMMANDS.OPEN_TOOL_INSTALL_URL, {
                url: action.url,
              })}
          >
            ${waIcon('arrow-up-right-from-square', { slot: 'start' })} Open
            install page
          </wa-button>
        `;
    }
  }

  private renderGuide(): TemplateResult | typeof nothing {
    if (
      !this.item.requiresSetup ||
      this.item.installActions.every((action) => action.kind === 'extension')
    ) {
      return nothing;
    }

    // When a primary install action exists (terminal command or extension
    // marketplace), demote auxiliary buttons (Sign in, Open install page)
    // to secondary styling.
    const hasPrimaryInstallAction = this.item.installActions.some(
      (action) => action.kind === 'command' || action.kind === 'extension',
    );
    const secondaryAppearance = hasPrimaryInstallAction ? 'outlined' : 'filled';
    const secondaryVariant = hasPrimaryInstallAction ? 'neutral' : 'brand';

    return html`
      <wa-details
        class="collapsible-quiet tool-guide-details"
        summary=${`Set up ${this.item.name}`}
        ?open=${this.guideExpanded}
        @wa-show=${this.handleGuideShow}
        @wa-hide=${this.handleGuideHide}
      >
        ${this.item.installActions.map((action) =>
          action.kind === 'guide'
            ? html`<div class="tool-guide">${action.text}</div>`
            : nothing,
        )}
        <div class="tool-guide-actions">
          ${this.item.installActions.map((action) =>
            this.renderInstallAction(
              action,
              secondaryAppearance,
              secondaryVariant,
            ),
          )}
        </div>
        ${
          this.item.configNotes
            ? html`<div class="tool-config-note">${this.item.configNotes}</div>`
            : nothing
        }
      </wa-details>
    `;
  }

  private renderToggle(): TemplateResult | typeof nothing {
    if (!this.item.toggleable) return nothing;
    const enabled = this.item.enabled !== false;
    // Constant name containing the visible "Use in runs" text (WCAG 2.5.3
    // Label in Name) — the on/off state is already carried by `checked`.
    const toggleLabel = `Use ${this.item.name} in runs`;
    return html`
      <wa-switch
        class="tool-toggle"
        title=${toggleLabel}
        ?checked=${enabled}
        aria-label=${toggleLabel}
        @change=${this.handleToggle}
      >
        Use in runs
      </wa-switch>
    `;
  }

  private renderAuthNote(): TemplateResult | typeof nothing {
    if (!this.item.authNote) return nothing;
    return html`
      <span class="tool-auth-note">
        ${waIcon('key')} <bdi dir="auto">${this.item.authNote}</bdi>
      </span>
    `;
  }

  override render(): TemplateResult {
    return html`
      <article class="tool-card">
        <div class="tool-header">
          <div class="tool-title-group">
            ${
              this.item.status === 'available'
                ? this.renderAvailableStatusIcon()
                : nothing
            }
            <h3 class="tool-name">
              <bdi dir="auto">${this.item.name}</bdi>
            </h3>
            ${
              this.item.status === 'available'
                ? nothing
                : this.renderStatusBadge()
            }
            ${this.renderAuthNote()}
          </div>
          ${this.renderToggle()}
        </div>
        <p class="tool-description" dir="auto">${this.item.description}</p>
        ${
          this.item.statusDetail
            ? html`<div class="tool-config-note" dir="auto">
                ${this.item.statusDetail}
              </div>`
            : nothing
        }
        ${
          this.item.tools.length > 0
            ? html`
                <ul class="tool-ids" aria-label="Included tools">
                  ${this.item.tools.map((tool, index) => {
                    const badgeId = `tool-id-badge-${this.item.id}-${index}`;
                    return html`<li class="tool-id">
                      <wa-badge
                        id=${badgeId}
                        class="tool-id-tag"
                        variant="neutral"
                        appearance="filled"
                        aria-label=${
                          tool.description
                            ? `${tool.name}: ${tool.description}`
                            : tool.name
                        }
                        ><bdi dir="auto">${tool.name}</bdi></wa-badge
                      >
                      <wa-tooltip for=${badgeId}
                        >${tool.description ?? tool.name}</wa-tooltip
                      >
                    </li>`;
                  })}
                </ul>
              `
            : nothing
        }
        <slot name="details"></slot>
        ${this.renderGuide()}
      </article>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tool-card': ToolCard;
  }
}
