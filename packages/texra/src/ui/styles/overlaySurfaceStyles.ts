import { css, type CSSResult } from 'lit';

/**
 * Chrome shared by the two `wa-drawer` overlays (the Tasks drawer and the
 * Tools sheet). The drawer owns the backdrop, Escape, light dismiss and the
 * focus trap; these rules hand its body to the surface's own column and lay
 * out the title-plus-close row each surface draws in place of the drawer's
 * header. Each surface still sets the drawer's `--size`.
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
