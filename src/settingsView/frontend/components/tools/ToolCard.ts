/**
 * ToolCard component - displays a single tool group with status, description,
 * and optional installation guide.
 */

// Third-party imports
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { codiconStyles, commonViewStyles, designTokens } from '@shared/styles';

// Local imports - shared schemas
import { createEvent } from '@shared/utils/events';
import type {
  ToolCommandKind,
  ToolDashboardItem,
} from '@shared/schemas/settingsViewMessages';

@customElement('tool-card')
export class ToolCard extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .tool-card {
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--border-radius);
        padding: var(--spacing-medium) var(--spacing-large);
        margin-bottom: var(--spacing-medium);
        background: var(
          --texra-editor-background,
          var(--texra-sideBar-background)
        );
        transition: border-color var(--transition-fast);
      }

      .tool-card:hover {
        border-color: var(--texra-focusBorder);
      }

      .tool-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: var(--spacing-medium);
        margin-bottom: var(--spacing-small);
      }

      .tool-title-group {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--spacing-small);
        min-width: 0;
      }

      .tool-name {
        font-weight: var(--font-weight-medium);
        font-size: var(--font-size);
        color: var(--texra-foreground);
        white-space: nowrap;
      }

      .tool-badge {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-small);
        padding: var(--border-thin) var(--spacing-small);
        font-size: var(--font-size-xs);
        border-radius: var(--border-radius);
        white-space: nowrap;
        font-weight: var(--font-weight-medium);
      }

      .tool-badge--available {
        color: var(--texra-testing-iconPassed, #73c991);
        background: color-mix(
          in srgb,
          var(--texra-testing-iconPassed, #73c991) 12%,
          transparent
        );
      }

      .tool-badge--not-found {
        color: var(--texra-testing-iconFailed, #f48771);
        background: color-mix(
          in srgb,
          var(--texra-testing-iconFailed, #f48771) 12%,
          transparent
        );
      }

      .tool-badge--unknown {
        color: var(--texra-badge-foreground);
        background: var(--texra-badge-background, rgba(128, 128, 128, 0.15));
      }

      .tool-description {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        margin-bottom: var(--spacing-small);
        line-height: var(--line-height-normal);
      }

      .tool-ids {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-small);
        margin-bottom: var(--spacing-small);
      }

      .tool-id-tag {
        font-family: var(--texra-editor-font-family, monospace), monospace;
        font-size: var(--font-size-xs);
        padding: var(--border-thin) var(--border-radius-large);
        background: var(--texra-badge-background, rgba(128, 128, 128, 0.15));
        color: var(--texra-badge-foreground);
        border-radius: var(--border-radius);
      }

      .tool-guide-toggle {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-small);
        padding: var(--spacing-tiny) 0;
        font-size: var(--font-size-sm);
        font-family: inherit;
        color: var(--texra-textLink-foreground, #3794ff);
        background: none;
        border: none;
        cursor: pointer;
        transition: opacity var(--transition-fast);
      }

      .tool-guide-toggle:hover {
        opacity: var(--opacity-hover);
      }

      .tool-guide-toggle:focus-visible {
        outline: var(--border-thin) solid var(--texra-focusBorder);
        outline-offset: 1px;
        border-radius: var(--border-radius-small);
      }

      .tool-guide {
        margin-top: var(--spacing-small);
        padding: var(--spacing-medium);
        background: var(
          --texra-textCodeBlock-background,
          rgba(128, 128, 128, 0.08)
        );
        border-radius: var(--border-radius);
        font-size: var(--font-size-sm);
        color: var(--texra-foreground);
        line-height: var(--line-height-relaxed);
        white-space: pre-wrap;
      }

      .tool-guide-actions {
        display: flex;
        gap: var(--spacing-small);
        margin-top: var(--spacing-small);
      }

      .tool-action-btn {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-small);
        padding: var(--spacing-tiny) var(--spacing-medium);
        font-size: var(--font-size-sm);
        font-family: inherit;
        color: var(--texra-button-foreground, #fff);
        background: var(--texra-button-background, #0e639c);
        border: none;
        border-radius: var(--border-radius);
        cursor: pointer;
        transition:
          background var(--transition-fast),
          opacity var(--transition-fast);
      }

      .tool-action-btn:hover {
        background: var(--texra-button-hoverBackground, #1177bb);
      }

      .tool-action-btn:focus-visible {
        outline: var(--border-thin) solid var(--texra-focusBorder);
        outline-offset: 1px;
      }

      .tool-action-btn--secondary {
        color: var(--texra-button-secondaryForeground, #ccc);
        background: var(
          --texra-button-secondaryBackground,
          rgba(128, 128, 128, 0.2)
        );
      }

      .tool-action-btn--secondary:hover {
        background: var(
          --texra-button-secondaryHoverBackground,
          rgba(128, 128, 128, 0.3)
        );
      }

      .tool-auth-note {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-small);
        padding: var(--border-thin) var(--spacing-small);
        font-size: var(--font-size-xs);
        border-radius: var(--border-radius);
        white-space: nowrap;
        font-weight: var(--font-weight-medium);
        color: var(--texra-charts-blue, #3794ff);
        background: color-mix(
          in srgb,
          var(--texra-charts-blue, #3794ff) 12%,
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
        margin-top: var(--spacing-small);
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
    const target = e.currentTarget as HTMLInputElement | null;
    this.dispatchEvent(
      createEvent('tool-toggle', {
        toolId: this.item.id,
        enabled: Boolean(target?.checked),
      }),
    );
  }

  private static readonly STATUS_CONFIG: Record<
    ToolDashboardItem['status'],
    { icon: string; label: string }
  > = {
    available: { icon: 'codicon-check', label: 'Ready' },
    'not-found': { icon: 'codicon-warning', label: 'Needs setup' },
    unknown: { icon: 'codicon-question', label: 'Not checked' },
  };

  private renderBadge(): TemplateResult {
    const { status } = this.item;
    const config =
      ToolCard.STATUS_CONFIG[status] ?? ToolCard.STATUS_CONFIG.unknown;

    return html`
      <span class="tool-badge tool-badge--${status}">
        <span class="codicon ${config.icon}"></span>
        ${this.item.statusLabel ?? config.label}
      </span>
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
    const secondaryClass = hasPrimaryInstallAction
      ? 'tool-action-btn--secondary'
      : '';

    return html`
      <button class="tool-guide-toggle" @click=${this.toggleGuide}>
        <span
          class="codicon ${this.guideExpanded
            ? 'codicon-chevron-down'
            : 'codicon-chevron-right'}"
        ></span>
        Installation Guide
      </button>
      ${this.guideExpanded
        ? html`
            ${this.item.installGuide
              ? html`<div class="tool-guide">${this.item.installGuide}</div>`
              : nothing}
            <div class="tool-guide-actions">
              ${this.item.installCommand
                ? html`
                    <button
                      class="tool-action-btn"
                      @click=${this.handleRunInstallCommand}
                      title=${this.item.installCommand}
                    >
                      <span class="codicon codicon-terminal"></span>
                      Install in Terminal
                    </button>
                  `
                : nothing}
              ${this.item.authCommand
                ? html`
                    <button
                      class="tool-action-btn ${secondaryClass}"
                      @click=${this.handleRunAuthCommand}
                      title=${this.item.authCommand}
                    >
                      <span class="codicon codicon-sign-in"></span>
                      Sign in
                    </button>
                  `
                : nothing}
              ${this.item.installExtensionId
                ? html`
                    <button
                      class="tool-action-btn"
                      @click=${this.handleInstallExtension}
                    >
                      <span class="codicon codicon-cloud-download"></span>
                      Install Extension
                    </button>
                  `
                : nothing}
              ${this.item.installUrl
                ? html`
                    <button
                      class="tool-action-btn ${secondaryClass}"
                      @click=${this.handleInstallUrl}
                    >
                      <span class="codicon codicon-link-external"></span>
                      Open Install Page
                    </button>
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
      <vscode-checkbox
        class="tool-toggle"
        title="${this.item.enabled !== false ? 'Disable' : 'Enable'} ${this.item
          .name} for agent runs"
        ?checked=${this.item.enabled !== false}
        aria-label="${this.item.enabled !== false ? 'Disable' : 'Enable'} ${this
          .item.name} for agent runs"
        @change=${this.handleToggle}
      >
        Use in runs
      </vscode-checkbox>
    `;
  }

  private renderAuthNote(): TemplateResult | typeof nothing {
    if (!this.item.authNote) return nothing;
    return html`
      <span class="tool-auth-note">
        <span class="codicon codicon-key"></span>
        ${this.item.authNote}
      </span>
    `;
  }

  override render(): TemplateResult {
    return html`
      <div class="tool-card">
        <div class="tool-header">
          <div class="tool-title-group">
            <span class="tool-name">${this.item.name}</span>
            ${this.renderBadge()} ${this.renderAuthNote()}
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
