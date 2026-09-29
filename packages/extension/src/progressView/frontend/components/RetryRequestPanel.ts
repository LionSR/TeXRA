/** Retry request card: "The request to <model> failed", Retry / Stop run. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { when } from 'lit/directives/when.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/details/details.js';

// Local imports - shared schemas
import type { ProviderErrorPartial } from '@shared/schemas';
import { getModelLabel } from '@shared/model/modelLabel';
import type { TeXRAIconName } from '@ui/wa/iconNames';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { tailWithEllipsis, toGraphemes } from '@utils/text/stringUtils';

// Local imports - base class
import { BaseRequestPanel } from './BaseRequestPanel';

// Local imports - styles
import { retryRequestPanelStyles } from './RetryRequestPanel.styles';

@customElement('retry-request-panel')
export class RetryRequestPanel extends BaseRequestPanel<'retry'> {
  static override styles = [BaseRequestPanel.styles, retryRequestPanelStyles];

  protected override get primaryIcon(): TeXRAIconName {
    return 'rotate-right';
  }

  protected override get decline(): 'stop' {
    return 'stop';
  }

  // A Copilot quota stop retries the same subscription; say so.
  protected override get primaryLabel(): string {
    return this.copilotQuotaExhausted() ? 'Retry Copilot' : 'Retry';
  }

  protected override submitPrimary(): void {
    this.emitAction({ action: 'retry' });
  }

  protected override renderAsk(): string {
    const { model } = this.permission.data;
    return model
      ? `The request to ${getModelLabel(model)} failed`
      : 'The model request failed';
  }

  protected override handleExtraKey(key: string): boolean {
    if (key !== 'k' || !this.canUseOwnApiKey()) return false;
    this.emitAction({ action: 'retry', credentials: 'personal' });
    return true;
  }

  override render(): TemplateResult {
    const data = this.permission.data;
    const detailsText = this.formatRetryDetails(data.errorDetails);
    const ownKeyLabel = this.copilotQuotaExhausted()
      ? 'Start with your own API key'
      : 'Retry with your own API key';

    return this.renderCard(
      html`
        ${when(
          data.errorMessage,
          () =>
            html`<div class="retry-request__error">${data.errorMessage}</div>`,
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
      `,
      this.canUseOwnApiKey()
        ? renderLabeledActionButton({
            icon: 'key',
            text: ownKeyLabel,
            title: `${ownKeyLabel} (k)`,
            action: 'useOwnApiKey',
            disabled: this.readOnly,
            onClick: () =>
              this.emitAction({ action: 'retry', credentials: 'personal' }),
          })
        : nothing,
    );
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private copilotQuotaExhausted(): boolean {
    return this.permission.data.credentialSwitch?.kind === 'copilot-fallback';
  }

  /** The run decided the offer; the card only renders it. */
  private canUseOwnApiKey(): boolean {
    return this.permission.data.credentialSwitch != null;
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
