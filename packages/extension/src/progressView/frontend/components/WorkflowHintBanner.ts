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
import { renderBannerFrame } from '@shared/wa/bannerFrame';

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
      /* wa-callout ignores --padding; set the real property (its :host hardcodes 1em). */
      padding: var(--wa-space-2xs) var(--wa-space-xs);
    }
    /* Pair the icon with the first text line instead of centering it in the
       multi-line block. */
    wa-callout::part(icon) {
      align-self: flex-start;
      margin-block-start: 0.2em;
      padding-inline-end: var(--wa-space-2xs);
    }
    /* Named .hint-row (not .banner-row) — this is a multi-line, flex-start
       layout distinct from the single-line, space-between .banner-row that
       bannerFrame.ts callers use. */
    .hint-row {
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
    return renderBannerFrame({
      id: 'workflowHintBanner',
      variant: 'brand',
      icon: 'info',
      role: 'note',
      ariaLabel: 'Workflow mode reminder',
      body: html`
        <div class="hint-row">
          <div class="text">
            <span class="title">Workflow mode thinks across rounds.</span>
            It reduces hallucinations and cuts fluff, so expect 10–30 minutes
            per run. Use Stop to cancel; pick Tool-Use mode for fast, iterative
            edits.
          </div>
          ${renderIconActionButton({
            id: 'workflow-hint-dismiss-button',
            icon: 'close',
            label: 'Dismiss workflow mode reminder',
            tooltip: 'Dismiss this reminder',
            onClick: this.handleDismiss,
          })}
        </div>
      `,
    });
  }
}
