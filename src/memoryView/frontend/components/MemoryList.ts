// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';

// Local imports - memory view components
import './MemoryItem';

// Local imports - shared schemas
import type { MemoryViewItem } from '@shared/schemas';

@customElement('memory-list')
export class MemoryList extends LitElement {
  static styles = [
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

  render(): TemplateResult {
    if (!this.items.length) {
      return html`<div class="empty-state">
        No saved memories yet. The assistant will create notes here when it
        needs to remember something.
      </div>`;
    }

    return html`
      <div class="memory-list">
        ${repeat(
          this.items,
          (item) => item.storagePath,
          (item) => html`<memory-item .item=${item}></memory-item>`,
        )}
      </div>
    `;
  }
}
