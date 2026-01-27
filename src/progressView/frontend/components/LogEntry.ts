/**
 * Declarative log entry component.
 * Renders log messages using Lit templates directly in Shadow DOM.
 */

// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - formatters
import { designTokens, commonViewStyles, codiconStyles } from '@shared/styles';
import { getSharedLogEntryFormatter } from '../formatters';

// Local imports - progress view styles
import { logStyles } from '../styles/logStyles';

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

  override render(): TemplateResult {
    if (!this.message) return html``;
    const formatter = getSharedLogEntryFormatter();
    return formatter.formatTemplate(this.message, {
      defaultOpen: this.defaultOpen,
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'log-entry': LogEntry;
  }
}
