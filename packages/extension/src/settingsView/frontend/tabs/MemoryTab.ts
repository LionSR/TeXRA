/** Memory management content for the settings view. */

import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import { designTokens, commonViewStyles } from '@shared/styles';
import type { MemoryViewItem } from '@shared/schemas';

// Side-effect: register child components.
import '../components/memory/MemoryToolbar';
import '../components/memory/MemoryToggle';
import '../components/memory/MemoryList';

@customElement('memory-tab')
export class MemoryTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .memory-view-container {
        display: flex;
        flex-direction: column;
        gap: var(--wa-space-xs);
      }

      .memory-description {
        margin: 0 0 var(--wa-space-xs) 0;
      }
    `,
  ];

  @property({ attribute: false }) items: MemoryViewItem[] = [];
  @property({ attribute: false }) enabled = false;
  @property({ attribute: false }) toggleDisabled = true;

  override render(): TemplateResult {
    return html`
      <div class="memory-view-container tab-content-container">
        <memory-toolbar></memory-toolbar>

        <memory-toggle
          .enabled=${this.enabled}
          .disabled=${this.toggleDisabled}
        ></memory-toggle>

        <p class="text-secondary memory-description">
          The AI assistant can save notes here to remember important information
          across conversations. These notes help the assistant provide more
          contextual and personalized help.
        </p>

        <memory-list .items=${this.items}></memory-list>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'memory-tab': MemoryTab;
  }
}
