/** Retry request panel for failed model requests. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { when } from 'lit/directives/when.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/details/details.js';

// Local imports - shared styles
import {
  commonViewStyles,
  designTokens,
  requestPanelSharedStyles,
} from '@shared/styles';

// Local imports - shared schemas
import type { ProviderErrorPartial } from '@shared/schemas';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { renderDotMeta, type MetaPart } from '@shared/wa/metaStrip';
import { tailWithEllipsis } from '@utils/text/stringUtils';

// Local imports - base class
import { BaseRequestPanel } from './BaseRequestPanel';

// Local imports - styles
import { retryRequestPanelStyles } from './RetryRequestPanel.styles';

@customElement('retry-request-panel')
export class RetryRequestPanel extends BaseRequestPanel<'retry'> {
  static override styles = [
    designTokens,
    commonViewStyles,
    requestPanelSharedStyles,
    retryRequestPanelStyles,
  ];

  override handleKeyboardShortcut(key: string): boolean {
    if (this.archived) return false;
    const data = this.permission.data;
    switch (key) {
      case 'r':
        this.emitAction('retry');
        return true;
      case 'k':
        if (data.errorDetails?.isCredentialExhausted) {
          this.emitAction('useOwnApiKey');
          return true;
        }
        return false;
      case 'escape':
        this.emitAction('cancel');
        return true;
      default:
        return false;
    }
  }

  override render(): TemplateResult {
    const data = this.permission.data;
    const isRelay = data.errorDetails?.isRelayError === true;
    const isCredentialExhausted =
      data.errorDetails?.isCredentialExhausted === true;
    const userRetryable = data.errorDetails?.userRetryable !== false;
    const metaParts: MetaPart[] = [
      ...(data.model ? [`Model: ${data.model}`] : []),
      ...(isRelay ? ['Source: Relay'] : []),
      `Can retry: ${userRetryable ? 'Yes' : 'No'}`,
    ];

    const detailsText = this.formatRetryDetails(data.errorDetails);
    const disabled = this.archived;

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
          <div class="retry-request__meta">${renderDotMeta(metaParts)}</div>
          ${when(
            data.errorMessage,
            () =>
              html`<div class="retry-request__error">
                ${data.errorMessage}
              </div>`,
          )}
          ${
            detailsText
              ? html`
                  <wa-details
                    class="retry-request__error-details collapsible-quiet"
                  >
                    <span slot="summary" class="retry-request__error-summary">
                      Error details
                    </span>
                    <div class="retry-request__error-body">${detailsText}</div>
                  </wa-details>
                `
              : nothing
          }
        </div>
        <div class="retry-request__actions">
          ${when(isCredentialExhausted, () =>
            renderLabeledActionButton({
              icon: 'key',
              text: 'Use your own API key',
              title: 'Use your own API key (k)',
              action: 'useOwnApiKey',
              disabled,
              onClick: () => this.emitAction('useOwnApiKey'),
            }),
          )}
          ${renderLabeledActionButton({
            icon: 'refresh',
            text: 'Retry',
            title: 'Retry (r)',
            action: 'retry',
            disabled,
            onClick: () => this.emitAction('retry'),
          })}
          ${renderLabeledActionButton({
            icon: 'close',
            text: 'Dismiss',
            title: 'Dismiss (Esc)',
            action: 'cancel',
            disabled,
            onClick: () => this.emitAction('cancel'),
          })}
        </div>
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
      const maxTailChars = 1024;
      const isTruncated = partialText.length > maxTailChars;
      const tail = tailWithEllipsis(partialText, maxTailChars);
      const header = isTruncated
        ? `--- Partial Output (last ${maxTailChars} of ${partialText.length} chars) ---`
        : `--- Partial Output (${partialText.length} chars) ---`;
      lines.push(header, tail);
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'retry-request-panel': RetryRequestPanel;
  }
}
