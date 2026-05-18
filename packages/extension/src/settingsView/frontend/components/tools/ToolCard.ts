/** Single tool group with status, description, and optional installation guide. */

import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';
import { TEXRA_ICON_LIBRARY } from '@shared/wa';

// Local imports - shared schemas
import { createEvent } from '@shared/utils/events';
import type {
  ToolCommandKind,
  ToolDashboardItem,
} from '@shared/schemas/settingsViewMessages';
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
        color: var(--wa-color-testing-passed, #73c991);
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

      .tool-id-tag {
        font-family: var(--wa-font-family-mono, monospace), monospace;
        font-size: var(--font-size-xs);
        padding: var(--border-thin) var(--border-radius-large);
        background: var(
          --wa-color-neutral-fill-quiet,
          rgba(128, 128, 128, 0.15)
        );
        border: var(--border-thin) solid
          var(--wa-color-neutral-border-quiet, transparent);
        color: var(--wa-color-neutral-on-quiet);
        border-radius: var(--border-radius);
      }

      .tool-guide-toggle::part(base) {
        min-height: var(--height-control);
        padding-inline: 0;
      }

      .tool-guide {
        margin-top: var(--wa-space-2xs);
        padding: var(--wa-space-xs);
        background: var(--wa-color-surface-lowered, rgba(128, 128, 128, 0.08));
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
        color: var(--wa-color-chart-blue, #3794ff);
        background: color-mix(
          in srgb,
          var(--wa-color-chart-blue, #3794ff) 12%,
          transparent
        );
      }

      .tool-toggle {
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
        margin-left: auto;
        color: var(--color-text-secondary);
        font-size: var(--font-size-sm);
      }

      @media (max-width: 420px) {
        .tool-header {
          align-items: flex-start;
        }

        .tool-toggle {
          width: 100%;
          margin-left: 0;
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

  private toggleGuide(): void {
    this.guideExpanded = !this.guideExpanded;
  }

  private handleInstallUrl(): void {
    if (this.item.installUrl) {
      this.dispatchEvent(
        createEvent('tool-open-url', { url: this.item.installUrl }),
      );
    }
  }

  private handleInstallExtension(): void {
    if (this.item.installExtensionId) {
      this.dispatchEvent(
        createEvent('tool-install-extension', {
          extensionId: this.item.installExtensionId,
        }),
      );
    }
  }

  private runCommand(kind: ToolCommandKind): void {
    this.dispatchEvent(
      createEvent('tool-run-command', { toolId: this.item.id, kind }),
    );
  }

  private handleRunInstallCommand(): void {
    this.runCommand('install');
  }

  private handleRunAuthCommand(): void {
    this.runCommand('auth');
  }

  private handleToggle(e: Event): void {
    const target = e.currentTarget as WaSwitch | null;
    this.dispatchEvent(
      createEvent('tool-toggle', {
        toolId: this.item.id,
        enabled: Boolean(target?.checked),
      }),
    );
  }

  private static readonly STATUS_CONFIG: Record<
    ToolDashboardItem['status'],
    {
      icon: string;
      label: string;
      variant: 'brand' | 'neutral' | 'success' | 'warning' | 'danger';
    }
  > = {
    available: { icon: 'check', label: 'Ready', variant: 'success' },
    'not-found': {
      icon: 'warning',
      label: 'Needs setup',
      variant: 'danger',
    },
    unknown: {
      icon: 'question',
      label: 'Not checked',
      variant: 'neutral',
    },
  };

  private renderAvailableStatusIcon(): TemplateResult {
    const config = ToolCard.STATUS_CONFIG.available;
    const label = this.item.statusLabel ?? config.label;

    return html`
      <span
        class="tool-status-icon"
        role="img"
        aria-label=${label}
        title=${label}
      >
        <wa-icon library="texra" name=${config.icon}></wa-icon>
      </span>
    `;
  }

  private renderStatusBadge(): TemplateResult {
    const { status } = this.item;
    const config =
      ToolCard.STATUS_CONFIG[status] ?? ToolCard.STATUS_CONFIG.unknown;
    const label = this.item.statusLabel ?? config.label;

    if (status === 'available') {
      return this.renderAvailableStatusIcon();
    }

    return html`
      <wa-tag
        class="tool-badge"
        variant=${config.variant}
        appearance="accent"
        size="small"
      >
        <wa-icon library="texra" name=${config.icon}></wa-icon>
        ${label}
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
      <wa-button
        class="tool-guide-toggle"
        appearance="plain"
        size="small"
        @click=${this.toggleGuide}
      >
        <wa-icon
          slot="start"
          library=${TEXRA_ICON_LIBRARY}
          name=${this.guideExpanded ? 'chevron-down' : 'chevron-right'}
          variant="solid"
        ></wa-icon>
        Installation Guide
      </wa-button>
      ${this.guideExpanded
        ? html`
            ${this.item.installGuide
              ? html`<div class="tool-guide">${this.item.installGuide}</div>`
              : nothing}
            <div class="tool-guide-actions">
              ${this.item.installCommand
                ? html`
                    <wa-button
                      appearance="filled"
                      variant="brand"
                      size="small"
                      @click=${this.handleRunInstallCommand}
                      title=${this.item.installCommand}
                    >
                      <wa-icon
                        slot="start"
                        library=${TEXRA_ICON_LIBRARY}
                        name="terminal"
                        variant="solid"
                      ></wa-icon>
                      Install in Terminal
                    </wa-button>
                  `
                : nothing}
              ${this.item.authCommand
                ? html`
                    <wa-button
                      appearance=${secondaryAppearance}
                      variant=${secondaryVariant}
                      size="small"
                      @click=${this.handleRunAuthCommand}
                      title=${this.item.authCommand}
                    >
                      <wa-icon
                        slot="start"
                        library=${TEXRA_ICON_LIBRARY}
                        name="right-to-bracket"
                        variant="solid"
                      ></wa-icon>
                      Sign in
                    </wa-button>
                  `
                : nothing}
              ${this.item.installExtensionId
                ? html`
                    <wa-button
                      appearance="filled"
                      variant="brand"
                      size="small"
                      @click=${this.handleInstallExtension}
                    >
                      <wa-icon
                        slot="start"
                        library=${TEXRA_ICON_LIBRARY}
                        name="cloud-arrow-down"
                        variant="solid"
                      ></wa-icon>
                      Install Extension
                    </wa-button>
                  `
                : nothing}
              ${this.item.installUrl
                ? html`
                    <wa-button
                      appearance=${secondaryAppearance}
                      variant=${secondaryVariant}
                      size="small"
                      @click=${this.handleInstallUrl}
                    >
                      <wa-icon
                        slot="start"
                        library=${TEXRA_ICON_LIBRARY}
                        name="arrow-up-right-from-square"
                        variant="solid"
                      ></wa-icon>
                      Open Install Page
                    </wa-button>
                  `
                : nothing}
            </div>
            ${this.item.configNotes
              ? html`<div class="tool-config-note">
                  ${this.item.configNotes}
                </div>`
              : nothing}
          `
        : nothing}
    `;
  }

  private renderToggle(): TemplateResult | typeof nothing {
    if (!this.item.toggleable) return nothing;
    return html`
      <wa-switch
        class="tool-toggle"
        title="${this.item.enabled !== false ? 'Disable' : 'Enable'} ${this.item
          .name} for agent runs"
        ?checked=${this.item.enabled !== false}
        aria-label="${this.item.enabled !== false ? 'Disable' : 'Enable'} ${this
          .item.name} for agent runs"
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
        <wa-icon library="texra" name="key"></wa-icon>
        ${this.item.authNote}
      </span>
    `;
  }

  override render(): TemplateResult {
    return html`
      <div class="tool-card">
        <div class="tool-header">
          <div class="tool-title-group">
            ${this.item.status === 'available'
              ? this.renderAvailableStatusIcon()
              : nothing}
            <span class="tool-name">${this.item.name}</span>
            ${this.item.status === 'available'
              ? this.renderAvailableStatusIcon()
              : this.renderStatusBadge()}
            ${this.renderAuthNote()}
          </div>
          ${this.renderToggle()}
        </div>
        <div class="tool-description">${this.item.description}</div>
        ${this.item.statusDetail
          ? html`<div class="tool-config-note">${this.item.statusDetail}</div>`
          : nothing}
        <div class="tool-ids">
          ${this.item.tools.map(
            (tool) =>
              html`<span
                class="tool-id-tag"
                title=${tool.description ?? tool.name}
                >${tool.name}</span
              >`,
          )}
        </div>
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
