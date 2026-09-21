import { css, type CSSResult } from 'lit';

/**
 * Chrome shared by a full-bleed overlay surface — a bottom sheet or a side
 * drawer: the host fills its container, a `.scrim` dims everything behind
 * it, and `.overlay-header`/`.overlay-title` lay out the title-plus-close
 * row. `ToolsSheet` and `SessionDrawer` each defined this independently
 * (`.sheet-header`/`.drawer-header` were byte-for-byte identical); this is
 * the one definition. Each surface still sets its own `:host` z-index and
 * `.scrim` tint, and its own panel geometry (bottom sheet vs. side panel) —
 * those aren't shared because they differ by design, not by drift.
 */
export const overlaySurfaceStyles: CSSResult = css`
  :host {
    position: absolute;
    inset: 0;
    display: block;
  }

  .scrim {
    position: absolute;
    inset: 0;
  }

  .overlay-header {
    display: flex;
    align-items: center;
    gap: var(--wa-space-3xs);
    flex: 0 0 auto;
    min-height: var(--height-header, 38px);
    padding: 0 var(--wa-space-2xs) 0 var(--wa-space-xs);
    border-bottom: var(--border-thin) solid var(--wa-color-surface-border);
  }

  .overlay-title {
    flex: 1 1 auto;
    font-weight: var(--font-weight-semibold);
  }
`;
