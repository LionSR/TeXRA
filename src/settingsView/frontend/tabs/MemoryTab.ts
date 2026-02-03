/**
 * MemoryTab component - memory management content for settings view.
 * Reuses memory view components from memoryView.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, codiconStyles, commonViewStyles } from '@shared/styles';

// Local imports - shared schemas
import type { MemoryViewItem } from '@shared/schemas';

// Local imports - settings view components (side-effect: register)
import '../components/memory/MemoryToolbar';
import '../components/memory/MemoryToggle';
import '../components/memory/MemoryList';

@customElement('memory-tab')
export class MemoryTab extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .memory-view-container {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-medium);
      }

      .memory-description {
        margin: 0 0 var(--spacing-medium) 0;
      }
    `,
  ];

  @property({ attribute: false }) items: MemoryViewItem[] = [];
  @property({ type: Boolean }) enabled = false;
  @property({ type: Boolean }) toggleDisabled = true;

  override render(): TemplateResult {
    return html`
      <div class="memory-view-container">
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
