import { css, type CSSResult } from 'lit';

/**
 * Chrome of a `wa-drawer` overlay (the Tasks drawer). The drawer owns the
 * backdrop, Escape, light dismiss and the focus trap; these rules hand its
 * body to the surface's own column and lay out the title-plus-close row the
 * surface draws in place of the drawer's header. The surface still sets the
 * drawer's `--size`.
 */
export const overlaySurfaceStyles: CSSResult = css`
  /* The drawer renders in the top layer; the host takes no room. */
  :host {
    display: contents;
  }

  wa-drawer {
    --spacing: 0;
  }

  wa-drawer::part(body) {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }

  .overlay-header {
    display: flex;
    align-items: center;
    gap: var(--wa-space-3xs);
    flex: 0 0 auto;
    min-height: var(--height-header);
    padding: 0 var(--wa-space-2xs) 0 var(--wa-space-xs);
    border-bottom: var(--border-thin) solid var(--wa-color-surface-border);
  }

  .overlay-title {
    flex: 1 1 auto;
    font-weight: var(--font-weight-semibold);
  }
`;

/**
 * Chrome shared by the `wa-popover` panels a status chip opens (the model
 * picker, the subscription meters): no arrow, no body padding, a panel as
 * wide as the host's `--popover-panel-width` that never leaves the window,
 * and the band that heads it.
 */
export const popoverPanelStyles: CSSResult = css`
  wa-popover {
    --arrow-size: 0;
    --max-width: var(--popover-panel-width);
  }

  wa-popover::part(body) {
    padding: 0;
  }

  .popover-panel {
    width: min(var(--popover-panel-width), calc(100vw - 2 * var(--wa-space-m)));
    font-size: var(--font-size-sm);
  }

  .popover-panel-head {
    display: flex;
    align-items: center;
    gap: var(--wa-space-xs);
    padding: var(--wa-space-xs) var(--wa-space-s);
    border-block-end: var(--border-thin) solid var(--color-border);
  }
`;
