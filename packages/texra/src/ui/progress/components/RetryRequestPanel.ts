/** Retry request card: "The request to <model> failed", Retry / Stop run. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/details/details.js';

// Local imports - shared schemas
import { getModelLabel, type RetryRequest } from '@texra-ai/harness/schemas';
import { REQUEST_ACTIONS } from '@texra/shared/session/surfaceDecision';
import { modelFailureText } from '@ui/copy/modelAccess';
import type { IconName } from '@ui/wa/iconNames';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';

// Local imports - base class
import { BaseRequestPanel } from './BaseRequestPanel';

// Local imports - styles
import { retryRequestPanelStyles } from './RetryRequestPanel.styles';

@customElement('retry-request-panel')
export class RetryRequestPanel extends BaseRequestPanel<'retry'> {
  static override styles = [BaseRequestPanel.styles, retryRequestPanelStyles];

  protected override get primaryIcon(): IconName {
    return 'rotate-right';
  }

  protected override get primaryLabel(): string {
    return 'Retry';
  }

  protected override renderAsk(): string {
    const { model } = this.permission.data;
    return model
      ? `The request to ${getModelLabel(model)} failed`
      : 'The model request failed';
  }

  protected override handleExtraKey(key: string): boolean {
    if (key !== 'k' || !this.canUseOwnApiKey()) return false;
    this.emitAction(REQUEST_ACTIONS.retry.k);
    return true;
  }

  override render(): TemplateResult {
    const data = this.permission.data;
    const detailsText = this.formatRetryDetails(data.failure);
    const ownKeyLabel = 'Retry with your own API key';

    return this.renderCard(
      html`
        <div class="retry-request__error">
          ${modelFailureText(data.failure)}
        </div>
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
            onClick: () => this.emitAction(REQUEST_ACTIONS.retry.k),
          })
        : nothing,
    );
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  /** The run decided the offer; the card only renders it. */
  private canUseOwnApiKey(): boolean {
    return this.permission.data.credentialSwitch != null;
  }

  private formatRetryDetails(failure: RetryRequest['failure']): string | null {
    const model = failure.source === 'model' ? failure : undefined;
    const lines = [
      failure.provider && `provider: ${failure.provider}`,
      model?.requestId && `requestId: ${model.requestId}`,
    ].filter(Boolean);

    // Show the tail of text that was generated before the failure — useful
    // both for diagnostics and for letting the user see progress wasn't lost.
    const partialText = model?.partialText;
    if (partialText) {
      const maxTailChars = 1024;
      // Counted in grapheme clusters, so the cut never tears one. A text one
      // grapheme over the tail is shown whole: the "…" would take that slot.
      const graphemes = Array.from(
        new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
          partialText,
        ),
        (s) => s.segment,
      );
      const totalChars = graphemes.length;
      const isTruncated = totalChars > maxTailChars + 1;
      const tail = isTruncated
        ? `…${graphemes.slice(-maxTailChars).join('')}`
        : partialText;
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
