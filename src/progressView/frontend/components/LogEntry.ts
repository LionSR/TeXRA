/**
 * Declarative log entry component.
 * Wraps the existing LogEntryFormatter in a reactive Lit component.
 */

// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - formatters
import { designTokens, commonViewStyles, codiconStyles } from '@shared/styles';
import { getSharedLogEntryFormatter } from '../formatters';

// Local imports - progress view styles
import { logStyles } from '../styles/logStyles';

// Local imports - shared styles

// Local imports - shared schemas
import type { LogMessageData } from '@shared/schemas';

@customElement('log-entry')
export class LogEntry extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconStyles,
    ...logStyles,
  ];

  @property({ type: Object }) message!: LogMessageData;
  @property({ type: Boolean }) defaultOpen = false;

  @state() private renderedElement: HTMLElement | null = null;

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
