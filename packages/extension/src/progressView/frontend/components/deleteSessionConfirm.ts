// The one permanent-delete confirmation: the run menu's Delete permanently
// (a trashed run, or a subagent) and the desktop Trash both ask here before
// the `run.delete` request leaves. Move to Trash never asks.
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
 * Asks before `run` is deleted for good. Confirming dispatches `run.delete`
 * from the button, so it reaches the session its surroundings name; either
 * button calls `dismiss`, which clears the host's confirming state. Escape
 * cancels.
 */
export function renderDeleteSessionConfirm(
  run: RunView,
  dismiss: () => void,
): TemplateResult {
  return html`<wa-callout
    class="delete-confirm"
    variant="danger"
    size="small"
    role="alertdialog"
    aria-label="Delete permanently"
    @keydown=${(event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      dismiss();
    }}
  >
    ${waIcon('trash', { slot: 'icon' })} Delete
    “${run.description || run.label}” permanently? Its conversation and run
    folder are removed for good.
    <div class="delete-confirm-actions">
      <wa-button
        id="confirmDeleteSession"
        variant="danger"
        size="s"
        @click=${(event: Event) => {
          const button = event.currentTarget as HTMLElement;
          button.dispatchEvent(
            SessionUiEvents.runtime({ kind: 'run.delete', runId: run.id }),
          );
          dismiss();
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
