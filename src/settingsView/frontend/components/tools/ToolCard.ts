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
import type { ToolDashboardItem } from '@shared/schemas/settingsViewMessages';

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
          --vscode-editor-background,
          var(--vscode-sideBar-background)
        );
        transition: border-color 0.15s ease;
      }

      .tool-card:hover {
        border-color: var(--vscode-focusBorder);
      }

      .tool-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-medium);
        margin-bottom: var(--spacing-small);
      }

      .tool-title-group {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
        min-width: 0;
      }

      .tool-name {
        font-weight: 500;
        font-size: var(--font-size);
        color: var(--vscode-foreground);
        white-space: nowrap;
      }

      .tool-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 1px var(--spacing-small);
        font-size: var(--font-size-xs, 11px);
        border-radius: var(--border-radius);
        white-space: nowrap;
        font-weight: 500;
      }

      .tool-badge--available {
        color: var(--vscode-testing-iconPassed, #73c991);
        background: rgba(115, 201, 145, 0.12);
      }

      .tool-badge--not-found {
        color: var(--vscode-testing-iconFailed, #f48771);
        background: rgba(244, 135, 113, 0.12);
      }

      .tool-badge--unknown {
        color: var(--color-text-secondary);
        background: var(--vscode-badge-background, rgba(128, 128, 128, 0.15));
      }

      .tool-description {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        margin-bottom: var(--spacing-small);
        line-height: 1.4;
      }

      .tool-ids {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-bottom: var(--spacing-small);
      }

      .tool-id-tag {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--font-size-xs, 11px);
        padding: 1px 6px;
        background: var(--vscode-badge-background, rgba(128, 128, 128, 0.15));
        color: var(--color-text-secondary);
        border-radius: var(--border-radius);
      }

      .tool-guide-toggle {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-small);
        padding: var(--spacing-tiny) 0;
        font-size: var(--font-size-sm);
        font-family: inherit;
        color: var(--vscode-textLink-foreground, #3794ff);
        background: none;
        border: none;
        cursor: pointer;
        transition: opacity 0.1s ease;
      }

      .tool-guide-toggle:hover {
        opacity: 0.8;
      }

      .tool-guide {
        margin-top: var(--spacing-small);
        padding: var(--spacing-medium);
        background: var(
          --vscode-textCodeBlock-background,
          rgba(128, 128, 128, 0.08)
        );
        border-radius: var(--border-radius);
        font-size: var(--font-size-sm);
        color: var(--vscode-foreground);
        line-height: 1.5;
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
        color: var(--vscode-button-foreground, #fff);
        background: var(--vscode-button-background, #0e639c);
        border: none;
        border-radius: var(--border-radius);
        cursor: pointer;
        transition:
          background 0.1s ease,
          opacity 0.1s ease;
      }

      .tool-action-btn:hover {
        background: var(--vscode-button-hoverBackground, #1177bb);
      }

      .tool-action-btn--secondary {
        color: var(--vscode-button-secondaryForeground, #ccc);
        background: var(
          --vscode-button-secondaryBackground,
          rgba(128, 128, 128, 0.2)
        );
      }

      .tool-action-btn--secondary:hover {
        background: var(
          --vscode-button-secondaryHoverBackground,
          rgba(128, 128, 128, 0.3)
        );
      }

      .tool-config-note {
        margin-top: var(--spacing-small);
        font-size: var(--font-size-xs, 11px);
        color: var(--color-text-secondary);
        font-style: italic;
      }
    `,
  ];

  @property({ attribute: false }) item!: ToolDashboardItem;

  @state() private guideExpanded = false;

  private toggleGuide(): void {
    this.guideExpanded = !this.guideExpanded;
  }

  private handleInstallUrl(): void {
    if (this.item.installUrl) {
      this.dispatchEvent(
        new CustomEvent('tool-open-url', {
          detail: { url: this.item.installUrl },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private renderBadge(): TemplateResult {
    const { status } = this.item;
    const iconClass =
      status === 'available'
        ? 'codicon-check'
        : status === 'not-found'
          ? 'codicon-warning'
          : 'codicon-question';
    const label =
      status === 'available'
        ? 'Available'
        : status === 'not-found'
          ? 'Not Found'
          : 'Unknown';

    return html`
      <span class="tool-badge tool-badge--${status}">
        <span class="codicon ${iconClass}"></span>
        ${label}
      </span>
    `;
  }

  private renderGuide(): TemplateResult | typeof nothing {
    if (!this.item.requiresSetup) return nothing;

    const hasGuide = this.item.installGuide || this.item.installUrl;
    if (!hasGuide) return nothing;

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
            <div class="tool-guide">${this.item.installGuide}</div>
            <div class="tool-guide-actions">
              ${this.item.installUrl
                ? html`
                    <button
                      class="tool-action-btn"
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

  override render(): TemplateResult {
    return html`
      <div class="tool-card">
        <div class="tool-header">
          <div class="tool-title-group">
            <span class="tool-name">${this.item.name}</span>
            ${this.renderBadge()}
          </div>
        </div>
        <div class="tool-description">${this.item.description}</div>
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
