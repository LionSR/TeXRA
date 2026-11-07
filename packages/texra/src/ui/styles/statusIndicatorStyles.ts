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

  .status-indicator.tone-running {
    background-color: var(--color-success);
  }

  .status-indicator.tone-success {
    background-color: var(--color-text-muted);
  }

  .status-indicator.tone-danger {
    background-color: var(--color-error);
  }

  /* Not the muted fill: a warning (interrupted, waiting on you) needs the
     user, and folding it in with completed/ready would make different
     states render as one dot.
     --color-pending is the accent already used for in-progress timers. */
  .status-indicator.tone-warning {
    background-color: var(--color-pending);
  }

  /* Same fill as the other quiet states: a neutral one is told apart by its position
     and its label, not by an alpha step nobody can see. */
  .status-indicator.tone-neutral {
    background-color: var(--color-text-muted);
  }
`;
