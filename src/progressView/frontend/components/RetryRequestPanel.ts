/**
 * Individual panel component for retry requests.
 *
 * Renders a single retry permission with error details,
 * retry/dismiss buttons, and stream diagnostics.
 *
 * Extends BaseRequestPanel for shared permission/emit/keyboard contract.
 */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { when } from 'lit/directives/when.js';

// Local imports - shared styles
import {
  codiconIconClasses,
  commonViewStyles,
  designTokens,
  requestPanelStyles,
} from '@shared/styles';

// Local imports - shared schemas
import type { ProviderErrorPartial, RetryPermission } from '@shared/schemas';
import { BaseRequestPanel } from './BaseRequestPanel';

// Local imports - base class

@customElement('retry-request-panel')
export class RetryRequestPanel extends BaseRequestPanel {
  static override styles = [
    designTokens,
    commonViewStyles,
    codiconIconClasses,
    requestPanelStyles,
  ];

  override handleKeyboardShortcut(key: string): boolean {
    switch (key) {
      case 'r':
        this.emitAction('retry');
        return true;
      case 'escape':
        this.emitAction('cancel');
        return true;
      default:
        return false;
    }
  }

  override render(): TemplateResult {
    const data = this.permission.data as RetryPermission;
    const isRelay = data.errorDetails?.isRelayError === true;
    const retryable = data.errorDetails?.retryable !== false;
    const metaParts = [
      data.model ? `Model: ${data.model}` : null,
      isRelay ? 'Source: Relay' : null,
      `Retryable: ${retryable ? 'Yes' : 'No'}`,
    ].filter(Boolean);

    const detailsText = this.formatRetryDetails(data.errorDetails);

    return html`
      <div
        class=${classMap({
          'retry-request': true,
          'retry-request--relay': isRelay,
        })}
      >
        <div class="retry-request__details">
          <div class="retry-request__operation">
            ${isRelay ? '[Relay] ' : ''}
            ${data.operation ? `Failed: ${data.operation}` : 'Request failed'}
          </div>
          <div class="retry-request__meta">${metaParts.join(' \u2022 ')}</div>
          ${when(
            data.errorMessage,
            () =>
              html`<div class="retry-request__error">
                ${data.errorMessage}
              </div>`,
          )}
          ${detailsText
            ? html`
                <details class="retry-request__error-details">
                  <summary class="retry-request__error-summary">
                    <i class="codicon codicon-chevron-right toggle-icon"></i>
                    Error details
                  </summary>
                  <div class="retry-request__error-body">${detailsText}</div>
                </details>
              `
            : nothing}
        </div>
        <vscode-toolbar-container class="retry-request__actions">
          <vscode-toolbar-button
            icon="refresh"
            label="Retry"
            title="Retry (r)"
            @click=${() => this.emitAction('retry')}
            >Retry</vscode-toolbar-button
          >
          <vscode-toolbar-button
            icon="close"
            label="Dismiss"
            title="Dismiss (Esc)"
            @click=${() => this.emitAction('cancel')}
            >Dismiss</vscode-toolbar-button
          >
        </vscode-toolbar-container>
      </div>
    `;
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private formatRetryDetails(
    details: ProviderErrorPartial | undefined,
  ): string | null {
    if (!details) return null;

    const formatBody = (v: unknown) =>
      typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);

    const lines = [
      details.provider && `provider: ${details.provider}`,
      details.requestId && `requestId: ${details.requestId}`,
      details.rawErrorBody != null &&
        `rawErrorBody: ${formatBody(details.rawErrorBody)}`,
    ].filter(Boolean);

    const diag = details.streamDiagnostics;
    if (diag && (diag.eventsProcessed > 0 || diag.messageStartReceived)) {
      const entries = Object.entries(diag).map(([k, v]) =>
        k === 'blockTypesSeen'
          ? `  ${k}: [${(v as string[])?.join(', ') || ''}]`
          : `  ${k}: ${v ?? 'null'}`,
      );
      lines.push('--- Stream Diagnostics ---', ...entries);
    }

    // Show the tail of text that was generated before the failure — useful
    // both for diagnostics and for letting the user see progress wasn't lost.
    const partialText = details.partialText;
    if (partialText) {
      const tail =
        partialText.length > 1024
          ? '…' + partialText.slice(partialText.length - 1024)
          : partialText;
      lines.push(
        `--- Partial Output (${partialText.length} chars) ---`,
        tail,
      );
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'retry-request-panel': RetryRequestPanel;
  }
}
