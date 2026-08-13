/** Single tool group with status, description, and optional installation guide. */

import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';

// Local imports - shared webview
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Local imports - shared schemas
import type {
  ToolCommandKind,
  ToolDashboardItem,
} from '@shared/schemas/settingsViewMessages';
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
        white-space: nowrap;
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
        margin-bottom: var(--wa-space-2xs);
        line-height: var(--line-height-normal);
      }

      .tool-ids {
        display: flex;
        flex-wrap: wrap;
        gap: var(--wa-space-2xs);
        margin-bottom: var(--wa-space-2xs);
      }

      wa-badge.tool-id-tag::part(base) {
        font-family: var(--wa-font-family-mono, monospace), monospace;
        font-size: var(--font-size-xs);
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
        white-space: nowrap;
        font-weight: var(--font-weight-medium);
        color: var(--color-info);
        background: color-mix(in srgb, var(--color-info) 12%, transparent);
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
        font-style: italic;
      }
    `,
  ];

  @property({ attribute: false }) item!: ToolDashboardItem;

  @state() private guideExpanded = false;

  /** Reveal the install buttons immediately when a tool first reports missing. */
  override willUpdate(changed: Map<string, unknown>): void {
    if (!changed.has('item')) return;
    const prev = changed.get('item') as ToolDashboardItem | undefined;
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

  private handleInstallUrl(): void {
    if (this.item.installUrl) {
      postMessage(SETTINGS_VIEW_COMMANDS.OPEN_TOOL_INSTALL_URL, {
        url: this.item.installUrl,
      });
    }
  }

  private handleInstallExtension(): void {
    if (this.item.installExtensionId) {
      postMessage(SETTINGS_VIEW_COMMANDS.INSTALL_TOOL_EXTENSION, {
        extensionId: this.item.installExtensionId,
      });
    }
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

  private static readonly STATUS_CONFIG: Record<
    ToolDashboardItem['status'],
    {
      icon: TeXRAIconName;
      variant: 'brand' | 'neutral' | 'success' | 'warning' | 'danger';
    }
  > = {
    available: { icon: 'check', variant: 'success' },
    'not-found': {
      icon: 'triangle-exclamation',
      variant: 'neutral',
    },
    unknown: {
      icon: 'circle-question',
      variant: 'neutral',
    },
    'coming-soon': {
      icon: 'clock',
      variant: 'neutral',
    },
  };

  private renderAvailableStatusIcon(): TemplateResult {
    const config = ToolCard.STATUS_CONFIG.available;
    const label = toolStatusLabel(this.item.status, this.item.statusLabel);

    return html`
      <span
        class="tool-status-icon"
        role="img"
        aria-label=${label}
        title=${label}
      >
        ${waIcon(config.icon)}
      </span>
    `;
  }

  private renderStatusBadge(): TemplateResult {
    const { status } = this.item;
    const config = ToolCard.STATUS_CONFIG[status];
    const label = toolStatusLabel(status, this.item.statusLabel);

    return html`
      <wa-tag class="tool-badge" variant=${config.variant} size="s">
        ${waIcon(config.icon)} ${label}
      </wa-tag>
    `;
  }

  private renderGuide(): TemplateResult | typeof nothing {
    if (!this.item.requiresSetup) return nothing;

    const hasGuide =
      this.item.installGuide ||
      this.item.installUrl ||
      this.item.installCommand ||
      this.item.authCommand;
    if (!hasGuide) return nothing;

    // When a primary install action exists (terminal command or extension
    // marketplace), demote auxiliary buttons (Sign in, Open Install Page)
    // to secondary styling.
    const hasPrimaryInstallAction = Boolean(
      this.item.installCommand || this.item.installExtensionId,
    );
    const secondaryAppearance = hasPrimaryInstallAction ? 'outlined' : 'filled';
    const secondaryVariant = hasPrimaryInstallAction ? 'neutral' : 'brand';

    return html`
      <wa-details
        class="collapsible-quiet tool-guide-details"
        summary="Setup guide"
        ?open=${this.guideExpanded}
        @wa-show=${this.handleGuideShow}
        @wa-hide=${this.handleGuideHide}
      >
        ${
          this.item.installGuide
            ? html`<div class="tool-guide">${this.item.installGuide}</div>`
            : nothing
        }
        <div class="tool-guide-actions">
          ${
            this.item.installCommand
              ? html`
                  <wa-button
                    id="tool-install-btn-${this.item.id}"
                    appearance="filled"
                    variant="brand"
                    size="s"
                    @click=${() => this.runCommand('install')}
                  >
                    ${waIcon('terminal', { slot: 'start' })} Install in Terminal
                  </wa-button>
                  <wa-tooltip for="tool-install-btn-${this.item.id}"
                    >${this.item.installCommand}</wa-tooltip
                  >
                `
              : nothing
          }
          ${
            this.item.authCommand
              ? html`
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
                    >${this.item.authCommand}</wa-tooltip
                  >
                `
              : nothing
          }
          ${
            this.item.installExtensionId
              ? html`
                  <wa-button
                    appearance="filled"
                    variant="brand"
                    size="s"
                    @click=${this.handleInstallExtension}
                  >
                    ${waIcon('cloud-arrow-down', { slot: 'start' })} Install
                    Extension
                  </wa-button>
                `
              : nothing
          }
          ${
            this.item.installUrl
              ? html`
                  <wa-button
                    appearance=${secondaryAppearance}
                    variant=${secondaryVariant}
                    size="s"
                    @click=${this.handleInstallUrl}
                  >
                    ${waIcon('arrow-up-right-from-square', { slot: 'start' })}
                    Open Install Page
                  </wa-button>
                `
              : nothing
          }
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
        ${waIcon('key')} ${this.item.authNote}
      </span>
    `;
  }

  override render(): TemplateResult {
    return html`
      <div class="tool-card">
        <div class="tool-header">
          <div class="tool-title-group">
            ${
              this.item.status === 'available'
                ? this.renderAvailableStatusIcon()
                : nothing
            }
            <span class="tool-name">${this.item.name}</span>
            ${
              this.item.status === 'available'
                ? nothing
                : this.renderStatusBadge()
            }
            ${this.renderAuthNote()}
          </div>
          ${this.renderToggle()}
        </div>
        <div class="tool-description">${this.item.description}</div>
        ${
          this.item.statusDetail
            ? html`<div class="tool-config-note">
                ${this.item.statusDetail}
              </div>`
            : nothing
        }
        ${
          this.item.tools.length > 0
            ? html`
                <div class="tool-ids">
                  ${this.item.tools.map((tool, index) => {
                    const badgeId = `tool-id-badge-${this.item.id}-${index}`;
                    return html`<wa-badge
                        id=${badgeId}
                        class="tool-id-tag"
                        variant="neutral"
                        appearance="filled"
                        >${tool.name}</wa-badge
                      >
                      <wa-tooltip for=${badgeId}
                        >${tool.description ?? tool.name}</wa-tooltip
                      >`;
                  })}
                </div>
              `
            : nothing
        }
        <slot name="details"></slot>
        ${this.renderGuide()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tool-card': ToolCard;
  }
}
