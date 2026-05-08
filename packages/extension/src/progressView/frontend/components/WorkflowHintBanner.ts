/**
 * Dismissible hint shown at the top of workflow stream tabs.
 *
 * Reminds users that workflow mode is slow by design — the multi-round
 * reflection keeps hallucinations down and trims fluffy prose, at the cost
 * of wall-clock time. Dismissal persists in webview storage so repeat users
 * don't see it after the first run.
 */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import { renderIconActionButton } from '@shared/wa/actionButtons';

import { webviewStorage } from '../webviewStorage';

const DISMISS_KEY = 'workflowHintBanner.dismissed';

@customElement('workflow-hint-banner')
export class WorkflowHintBanner extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
    .banner {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 8px 10px;
      margin: 0 0 8px 0;
      background: var(--texra-textBlockQuote-background);
      border-left: 3px solid var(--wa-color-text-link);
      border-radius: 3px;
      font-size: 0.9em;
      color: var(--wa-color-text-normal);
    }
    .text {
      flex: 1;
      line-height: 1.45;
    }
    .title {
      font-weight: 600;
      margin-right: 4px;
    }
  `;

  @state()
  private dismissed = webviewStorage.get(DISMISS_KEY) === true;

  private handleDismiss = (): void => {
    webviewStorage.set(DISMISS_KEY, true);
    this.dismissed = true;
  };

  override render(): TemplateResult | typeof nothing {
    if (this.dismissed) return nothing;
    return html`
      <div class="banner" role="note" aria-label="Workflow mode reminder">
        <div class="text">
          <span class="title">Workflow mode thinks across rounds.</span>
          It reduces hallucinations and cuts fluff, so expect 10–30 minutes per
          run. Use Stop to cancel; pick Tool-Use mode for fast, iterative edits.
        </div>
        ${renderIconActionButton({
          icon: 'close',
          label: 'Dismiss workflow mode reminder',
          title: 'Dismiss this reminder',
          onClick: this.handleDismiss,
        })}
      </div>
    `;
  }
}
