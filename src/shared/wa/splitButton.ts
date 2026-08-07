// Third-party imports
import { html, type TemplateResult } from 'lit';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - Web Awesome
import { waIcon } from './webAwesomeIcons';

export interface SplitButtonMenuOptions {
  /**
   * Component-specific class prefix ('approve-split', 'diff-dropdown'). The
   * menu renders `<prefix>-menu split-button-menu` and the caret trigger
   * `<prefix>-trigger split-button-trigger`: the prefixed names sit alongside
   * the shared ones (skinned by `splitButtonStyles`) because component tests
   * query them.
   */
  readonly classPrefix: string;
  /** Trigger button id; the tooltip anchors to it via `for`. */
  readonly triggerId: string;
  readonly triggerAriaLabel: string;
  readonly tooltip: string;
  /** The `wa-dropdown-item` entries. */
  readonly items: TemplateResult;
  /**
   * Selection callback. Receives the selected item's `value` ('' when the
   * event carries none) — `wa-select` fires on Enter/Space rather than as a
   * DOM click, so callers must not rely on click handlers on the items.
   */
  readonly onSelect: (value: string) => void;
}

/**
 * The caret half of a split button: a `<wa-dropdown>` with a chevron trigger
 * plus its `<wa-tooltip>`. The caller renders the main action button and the
 * `<div class="<prefix> split-button">` wrapper (which owns the width budget)
 * and decides whether the menu renders at all.
 */
export function renderSplitButtonMenu({
  classPrefix,
  triggerId,
  triggerAriaLabel,
  tooltip,
  items,
  onSelect,
}: SplitButtonMenuOptions): TemplateResult {
  return html`
    <wa-dropdown
      class="${classPrefix}-menu split-button-menu"
      placement="bottom-end"
      @wa-select=${(event: CustomEvent<{ item: HTMLElement }>) =>
        onSelect(
          (event.detail?.item as HTMLElement & { value?: string })?.value ?? '',
        )}
    >
      <wa-button
        id=${triggerId}
        slot="trigger"
        class="${classPrefix}-trigger split-button-trigger"
        appearance="plain"
        variant="neutral"
        size="s"
        type="button"
        aria-label=${triggerAriaLabel}
      >
        ${waIcon('chevron-down')}
      </wa-button>
      ${items}
    </wa-dropdown>
    <wa-tooltip for=${triggerId}>${tooltip}</wa-tooltip>
  `;
}
