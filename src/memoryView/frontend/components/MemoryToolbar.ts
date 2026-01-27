/**
 * MemoryToolbar component - header with refresh and open folder actions.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, codiconStyles, commonViewStyles } from '@shared/styles';

// Local imports - memory view events
import { MemoryViewEvents } from '../events';

@customElement('memory-toolbar')
export class MemoryToolbar extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .view-header {
        gap: var(--spacing-medium);
      }
    `,
  ];

  private handleRefresh = (): void => {
    this.dispatchEvent(MemoryViewEvents.refresh());
  };

  private handleOpenFolder = (): void => {
    this.dispatchEvent(MemoryViewEvents.openFolder());
  };

  override render(): TemplateResult {
    return html`
      <header class="view-header">
        <h2>Agent Memory</h2>
        <vscode-toolbar-container>
          <vscode-toolbar-button
            icon="refresh"
            label="Refresh"
            title="Refresh"
            @click=${this.handleRefresh}
          ></vscode-toolbar-button>
          <vscode-toolbar-button
            icon="folder-opened"
            label="Open Folder"
            title="Open in file explorer"
            @click=${this.handleOpenFolder}
          ></vscode-toolbar-button>
        </vscode-toolbar-container>
      </header>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'memory-toolbar': MemoryToolbar;
  }
}
