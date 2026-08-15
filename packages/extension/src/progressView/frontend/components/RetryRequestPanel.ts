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
import {
  isCredentialExhausted,
  type ProviderErrorPartial,
} from '@shared/schemas';
import { INCLUDED_ACCESS } from '@shared/copy/modelAccess';
import { isKimiCodeSubscriptionRetryBlocked } from '@shared/model/kimiCodeRetryGate';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { renderDotMeta, type MetaPart } from '@shared/wa/metaStrip';
import { tailWithEllipsis, toGraphemes } from '@utils/text/stringUtils';

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
        this.emitAction({ action: 'retry' });
        return true;
      case 'k':
        if (this.canUseOwnApiKey()) {
          this.emitAction({ action: 'useOwnApiKey' });
          return true;
        }
        return false;
      case 'escape':
        this.emitAction({ action: 'cancel' });
        return true;
      default:
        return false;
    }
  }

  override render(): TemplateResult {
    const data = this.permission.data;
    const isRelay = data.errorDetails?.isRelayError === true;
    const canUseOwnApiKey = this.canUseOwnApiKey();
    const copilotQuotaExhausted =
      data.errorDetails?.exhaustionReason === 'copilot-subscription';
    const userRetryable = data.errorDetails?.userRetryable !== false;
    const metaParts: MetaPart[] = [
      ...(data.model ? [`Model: ${data.model}`] : []),
      ...(isRelay ? [`Source: ${INCLUDED_ACCESS.label}`] : []),
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
          ${when(canUseOwnApiKey, () =>
            renderLabeledActionButton({
              icon: 'key',
              text: copilotQuotaExhausted
                ? 'Start with your own API key'
                : 'Retry with your own API key',
              title: copilotQuotaExhausted
                ? 'Start a new run with your own API key (k)'
                : 'Retry with your own API key (k)',
              action: 'useOwnApiKey',
              disabled,
              onClick: () => this.emitAction({ action: 'useOwnApiKey' }),
            }),
          )}
          ${renderLabeledActionButton({
            icon: 'rotate-right',
            text: copilotQuotaExhausted ? 'Retry Copilot' : 'Retry',
            title: copilotQuotaExhausted ? 'Retry Copilot (r)' : 'Retry (r)',
            action: 'retry',
            disabled,
            onClick: () => this.emitAction({ action: 'retry' }),
          })}
          ${renderLabeledActionButton({
            icon: 'xmark',
            text: 'Dismiss',
            title: 'Dismiss (Esc)',
            action: 'cancel',
            disabled,
            onClick: () => this.emitAction({ action: 'cancel' }),
          })}
        </div>
      </div>
    `;
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private canUseOwnApiKey(): boolean {
    const data = this.permission.data;
    return (
      isCredentialExhausted(data.errorDetails) &&
      !isKimiCodeSubscriptionRetryBlocked(
        data.model,
        data.errorDetails?.exhaustionReason,
      )
    );
  }

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
      // tailWithEllipsis's budget covers its own leading "…", so pass one
      // more than the content characters we actually want displayed.
      const tail = tailWithEllipsis(partialText, maxTailChars + 1);
      // Derive truncation from what tailWithEllipsis actually did (it
      // returns the input unchanged when nothing needs cutting) rather than
      // a separately-computed length comparison — two independent
      // decisions about the same cutoff disagreed by one grapheme exactly
      // at the boundary (partialText.length === maxTailChars + 1), where
      // this said "truncated" but tailWithEllipsis returned the text whole.
      const isTruncated = tail !== partialText;
      const totalChars = toGraphemes(partialText).length;
      const header = isTruncated
        ? `--- Partial Output (last ${maxTailChars} of ${totalChars} chars) ---`
        : `--- Partial Output (${totalChars} chars) ---`;
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
