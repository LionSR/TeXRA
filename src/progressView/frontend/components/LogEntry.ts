/**
 * Declarative log entry component.
 * Wraps the existing LogEntryFormatter in a reactive Lit component.
 */

// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - formatters
import { getSharedLogEntryFormatter } from '../formatters';

// Local imports - shared schemas
import type { LogMessageData } from '@shared/schemas';

@customElement('log-entry')
export class LogEntry extends LitElement {
  @property({ type: Object }) message!: LogMessageData;
  @property({ type: Boolean }) defaultOpen = false;

  @state() private renderedElement: HTMLElement | null = null;

  protected override createRenderRoot(): HTMLElement {
    // Use Light DOM for CSS compatibility
    return this;
  }

  override willUpdate(changedProperties: Map<string, unknown>): void {
    if (
      changedProperties.has('message') ||
      changedProperties.has('defaultOpen')
    ) {
      this.renderedElement = this.formatMessage();
    }
  }

  private formatMessage(): HTMLElement | null {
    if (!this.message) return null;
    const formatter = getSharedLogEntryFormatter();
    return formatter.format(this.message, { defaultOpen: this.defaultOpen });
  }

  override render(): TemplateResult {
    // Render the formatted element directly into the Light DOM
    if (this.renderedElement) {
      return html`${this.renderedElement}`;
    }
    return html``;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'log-entry': LogEntry;
  }
}
