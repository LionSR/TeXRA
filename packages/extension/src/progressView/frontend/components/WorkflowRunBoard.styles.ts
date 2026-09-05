// Third-party imports
import { css } from 'lit';

/** Styles for <workflow-run-board>: the phase strip, the rows, the tally
 *  line, and the controls bar. Width decides the note copy (G4). */
export const workflowRunBoardStyles = css`
  :host {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    flex: 1 1 auto;
    container-type: inline-size;
    color: var(--wa-color-text-normal);
    font-size: var(--font-size-sm);
  }

  .quiet {
    color: var(--wa-color-text-quiet);
  }

  .spacer {
    flex: 1 1 auto;
  }

  .tone-running {
    color: var(--wa-color-success-on-quiet);
  }

  .tone-danger {
    color: var(--wa-color-danger-on-quiet);
  }

  .tone-warning {
    color: var(--wa-color-warning-on-quiet);
  }

  /* Summary line: the desktop's run headline above the phases. */
  .summary {
    display: flex;
    align-items: center;
    gap: var(--wa-space-m);
    padding: var(--wa-space-s) var(--wa-space-2xs) 0;
    font-variant-numeric: tabular-nums;
  }

  .summary .quiet {
    display: inline-flex;
    align-items: center;
    gap: var(--wa-space-2xs);
  }

  /* Phase strip. The strip fills the board so the body scrolls and the tally
     and controls below it sit at the pane's bottom; the track is painted out
     but its width stays, which is what the active tab's indicator is drawn
     with. */
  .phases {
    flex: 1 1 auto;
    min-height: 0;
    --track-color: transparent;
  }

  .phases::part(base) {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .phases::part(nav) {
    flex: 0 0 auto;
  }

  .phases::part(body) {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }

  .phase-tab {
    display: inline-flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    font-variant-numeric: tabular-nums;
  }

  .phase-tab.is-declared {
    color: var(--wa-color-text-quiet);
  }

  .phase-tab wa-badge {
    margin-inline-start: var(--wa-space-3xs);
  }

  wa-tab-panel::part(base) {
    padding: 0;
  }

  /* Rows */
  .rows {
    display: flex;
    flex-direction: column;
    padding: var(--wa-space-2xs) 0 var(--wa-space-s);
  }

  /* The desktop's headline variant keeps the rows in a bordered card. */
  :host([summary]) .rows {
    margin-top: var(--wa-space-xs);
    border: var(--border-thin) solid var(--wa-color-surface-border);
    border-radius: var(--wa-border-radius-m);
  }

  .section {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    padding: var(--wa-space-s) var(--wa-space-s) var(--wa-space-3xs);
    font-size: var(--font-size-xs);
    font-weight: var(--wa-font-weight-semibold);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--wa-color-text-quiet);
  }

  .section .count {
    font-weight: var(--wa-font-weight-normal);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--wa-space-xs);
    min-height: 34px;
    padding: var(--wa-space-2xs) var(--wa-space-s);
    border-top: var(--border-thin) solid var(--wa-color-surface-border);
    min-width: 0;
  }

  .row.is-linked {
    cursor: pointer;
  }

  .row.is-linked:hover {
    background: var(--wa-color-surface-lowered);
  }

  .row.is-focused {
    outline: var(--border-medium) solid var(--wa-color-brand-border-loud);
    outline-offset: -2px;
  }

  .row-icon {
    display: inline-flex;
    flex: 0 0 auto;
    font-size: 12px;
  }

  .row-label {
    flex: 0 0 auto;
    max-width: 45%;
    font-weight: var(--wa-font-weight-semibold);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row-last {
    flex: 1 1 auto;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--wa-color-text-quiet);
  }

  .row-last.is-error {
    color: var(--wa-color-danger-on-quiet);
  }

  .row-meta {
    flex: 0 0 auto;
    max-width: 40%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: var(--font-size-xs);
    font-variant-numeric: tabular-nums;
    color: var(--wa-color-text-quiet);
  }

  .row-actions {
    display: inline-flex;
    flex: 0 0 auto;
    gap: var(--wa-space-2xs);
  }

  .row-open {
    flex: 0 0 auto;
    font-size: 10px;
    color: var(--wa-color-text-quiet);
  }

  .row.status-running .row-icon,
  .row.status-completed .row-icon,
  .row.status-cached .row-icon {
    color: var(--wa-color-success-on-quiet);
  }

  .row.is-waiting .row-icon {
    color: var(--wa-color-warning-on-quiet);
  }

  .row.status-failed .row-icon {
    color: var(--wa-color-danger-on-quiet);
  }

  .row.status-planned .row-icon,
  .row.status-queued .row-icon,
  .row.status-declared .row-icon,
  .row.status-skipped .row-icon,
  .row.status-cancelled .row-icon {
    color: var(--wa-color-text-quiet);
  }

  .row.status-declared .row-label {
    font-weight: var(--wa-font-weight-normal);
    color: var(--wa-color-text-quiet);
  }

  /* Counted groups fold in place. */
  .fold {
    margin: var(--wa-space-xs) var(--wa-space-s) 0;
  }

  .fold::part(base) {
    border: var(--border-thin) solid var(--wa-color-surface-border);
    border-radius: var(--wa-border-radius-m);
  }

  .fold::part(header) {
    padding: var(--wa-space-s) var(--wa-space-m);
    font-size: var(--font-size-sm);
  }

  .fold::part(content) {
    padding: 0;
  }

  .fold .row:first-child {
    border-top: none;
  }

  /* Tally line */
  .tally {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    flex: 0 0 auto;
    padding: var(--wa-space-2xs) var(--wa-space-s);
    border-top: var(--border-thin) solid var(--wa-color-surface-border);
    font-size: var(--font-size-xs);
    font-variant-numeric: tabular-nums;
    color: var(--wa-color-text-quiet);
    white-space: nowrap;
  }

  .tally wa-icon {
    font-size: 9px;
  }

  /* Controls bar */
  .controls {
    display: flex;
    align-items: center;
    gap: var(--wa-space-2xs);
    flex: 0 0 auto;
    margin: var(--wa-space-xs) var(--wa-space-s) var(--wa-space-s);
    padding: var(--wa-space-2xs) var(--wa-space-xs);
    border: var(--border-thin) solid var(--wa-color-surface-border);
    border-radius: var(--wa-border-radius-l);
  }

  .controls .note {
    flex: 1 1 auto;
    min-width: 0;
    padding-inline: var(--wa-space-2xs);
    font-size: var(--font-size-xs);
    color: var(--wa-color-text-quiet);
    text-align: end;
  }

  .note-wide {
    display: none;
  }

  @container (min-width: 720px) {
    .note-narrow {
      display: none;
    }

    .note-wide {
      display: inline;
    }
  }
`;
