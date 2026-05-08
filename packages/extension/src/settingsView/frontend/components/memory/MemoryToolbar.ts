/**
 * MemoryToolbar component - header with refresh and open folder actions.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';
import { renderIconActionButton } from '@shared/wa/actionButtons';

// Local imports - memory view events
import { MemoryViewEvents } from './events';

@customElement('memory-toolbar')
export class MemoryToolbar extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .view-header {
        gap: var(--wa-space-xs);
      }
    `,
  ];

  private handleRefresh(): void {
    this.dispatchEvent(MemoryViewEvents.refresh());
  }

  private handleOpenFolder(): void {
    this.dispatchEvent(MemoryViewEvents.openFolder());
  }

  override render(): TemplateResult {
    return html`
      <header class="view-header">
        <div class="action-button-group">
          ${renderIconActionButton({
            icon: 'rotate-right',
            label: 'Refresh',
            onClick: this.handleRefresh,
          })}
          ${renderIconActionButton({
            icon: 'folder-open',
            label: 'Open Folder',
            title: 'Open in file explorer',
            onClick: this.handleOpenFolder,
          })}
        </div>
      </header>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'memory-toolbar': MemoryToolbar;
  }
}
