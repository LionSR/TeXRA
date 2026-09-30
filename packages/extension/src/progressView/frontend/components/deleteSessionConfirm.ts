// The one Delete-session confirmation: the run header's menu item and the
// desktop rail row's × both ask here before the `run.delete` request leaves.
import { css, html, type TemplateResult } from 'lit';

import type { RunView } from '@shared/session/sessionView';
import { SessionUiEvents } from '@shared/session/uiEvents';
import { waIcon } from '@ui/wa/webAwesomeIcons';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';

export const deleteSessionConfirmStyles = css`
  .delete-confirm {
    margin: var(--wa-space-2xs) 0;
  }
  .delete-confirm-actions {
    display: flex;
    gap: var(--wa-space-2xs);
    margin-top: var(--wa-space-2xs);
  }
`;

/**
 * Asks before `run` is deleted. Confirming dispatches `run.delete` from
 * `host`; either button calls `dismiss`, which clears the host's
 * confirming state. Escape cancels.
 */
export function renderDeleteSessionConfirm(
  host: HTMLElement,
  run: RunView,
  dismiss: () => void,
): TemplateResult {
  return html`<wa-callout
    class="delete-confirm"
    variant="danger"
    size="small"
    role="alertdialog"
    aria-label="Delete session"
    @keydown=${(event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      dismiss();
    }}
  >
    ${waIcon('trash', { slot: 'icon' })} Delete “${run.label}”? Its conversation
    and run folder are removed for good.
    <div class="delete-confirm-actions">
      <wa-button
        id="confirmDeleteSession"
        variant="danger"
        size="s"
        @click=${() => {
          dismiss();
          host.dispatchEvent(
            SessionUiEvents.runtime({ kind: 'run.delete', runId: run.id }),
          );
        }}
        >Delete</wa-button
      >
      <wa-button
        class="delete-confirm-cancel"
        appearance="plain"
        size="s"
        @click=${dismiss}
        >Cancel</wa-button
      >
    </div>
  </wa-callout>`;
}
