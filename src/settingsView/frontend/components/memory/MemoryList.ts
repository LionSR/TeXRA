/**
 * MemoryList component - renders list of saved memory items.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';

// Local imports - memory view components (side-effect: register)
import './MemoryItem';

// Local imports - shared schemas
import type { MemoryViewItem } from '@shared/schemas';

@customElement('memory-list')
export class MemoryList extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .memory-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-medium);
      }
    `,
  ];

  @property({ attribute: false }) items: MemoryViewItem[] = [];

  override render(): TemplateResult {
    if (!this.items.length) {
      return html`<div class="empty-state">
        <span class="codicon codicon-database"></span>
        <p>No saved memories yet.</p>
        <p class="text-secondary">
          Memories are created automatically when the assistant learns something
          worth remembering across conversations.
        </p>
      </div>`;
    }

    return html`
      <div class="memory-list">
        ${repeat(
          this.items,
          (item) => item.storagePath,
          (item) =>
            html`<memory-item
              .item=${item}
              ?pinned=${item.pinned}
            ></memory-item>`,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'memory-list': MemoryList;
  }
}
