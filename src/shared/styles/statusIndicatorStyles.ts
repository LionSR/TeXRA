import { css, type CSSResult } from 'lit';

/**
 * The 8px status dot.
 *
 * Every state expresses its step in colour alone. The previous version layered
 * an element `opacity` on top of `--wa-color-text-quiet`, which is itself
 * `color-mix(… 70%, transparent)` — so the quiet states composited to 0.49 and
 * the `is-ready` state to 0.35 effective alpha, measuring 2.65:1 and 1.94:1
 * against the 3:1 minimum for a non-text indicator. `--color-text-muted`
 * carries that de-emphasis once, at a value that holds in every theme.
 *
 * The saturated states never needed `opacity: 1` — that was only undoing the
 * base rule's fade.
 */
export const statusIndicatorStyles: CSSResult = css`
  .status-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
    background-color: var(--color-text-muted);
  }

  .status-indicator.is-running {
    background-color: var(--color-success);
  }

  .status-indicator.is-completed,
  .status-indicator.is-cancelled {
    background-color: var(--color-text-muted);
  }

  .status-indicator.is-failed {
    background-color: var(--color-error);
  }

  .status-indicator.is-waiting,
  .status-indicator.is-resuming {
    background-color: var(--wa-color-text-link);
  }

  /* Not the muted fill: "starting" is in progress, and folding it in with
     completed/cancelled/ready made five different states render as one dot.
     --color-pending is the accent already used for in-progress timers. */
  .status-indicator.is-starting {
    background-color: var(--color-pending);
  }

  /* Same fill as the other quiet states: "ready" is told apart by its position
     and its label, not by an alpha step nobody can see. */
  .status-indicator.is-ready {
    background-color: var(--color-text-muted);
  }
`;
