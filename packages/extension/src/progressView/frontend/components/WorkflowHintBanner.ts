/**
 * Dismissible hint shown at the top of workflow stream tabs.
 *
 * Reminds users that workflow mode is slow by design — the multi-round
 * reflection keeps hallucinations down and trims fluffy prose, at the cost
 * of wall-clock time. Dismissal persists in webview storage so repeat users
 * don't see it after the first run.
 */

import '@awesome.me/webawesome/dist/components/callout/callout.js';
import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import { renderIconActionButton } from '@shared/wa/actionButtons';
import { waIcon } from '@shared/wa/webAwesomeIcons';

import { webviewStorage } from '../webviewStorage';

const DISMISS_KEY = 'workflowHintBanner.dismissed';

@customElement('workflow-hint-banner')
export class WorkflowHintBanner extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
    wa-callout {
      margin: 0 0 var(--wa-space-2xs) 0;
      --padding: var(--wa-space-2xs) var(--wa-space-xs);
    }
    .banner-row {
      display: flex;
      align-items: flex-start;
      gap: var(--wa-space-2xs);
    }
    .text {
      flex: 1;
      line-height: var(--line-height-normal);
    }
    .title {
      font-weight: var(--font-weight-semibold);
      margin-right: var(--wa-space-3xs);
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
      <wa-callout
        variant="brand"
        role="note"
        aria-label="Workflow mode reminder"
      >
        ${waIcon('info', { slot: 'icon' })}
        <div class="banner-row">
          <div class="text">
            <span class="title">Workflow mode thinks across rounds.</span>
            It reduces hallucinations and cuts fluff, so expect 10–30 minutes
            per run. Use Stop to cancel; pick Tool-Use mode for fast, iterative
            edits.
          </div>
          ${renderIconActionButton({
            icon: 'close',
            label: 'Dismiss workflow mode reminder',
            title: 'Dismiss this reminder',
            onClick: this.handleDismiss,
          })}
        </div>
      </wa-callout>
    `;
  }
}
