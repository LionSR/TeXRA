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

type SplitButtonAppearance = 'filled' | 'outlined' | 'plain';
type SplitButtonVariant = 'brand' | 'neutral';

export interface SplitButtonMenuOptions {
  /**
   * Component-specific class prefix ('approve-split', 'diff-dropdown'). The
   * menu renders `<prefix>-menu split-button-menu` and the caret trigger
   * `<prefix>-trigger split-button-trigger`: the prefixed names sit alongside
   * the shared ones so callers can style and query each part.
   */
  readonly classPrefix: string;
  /** Trigger button id; the tooltip anchors to it via `for`. */
  readonly triggerId: string;
  readonly triggerAriaLabel: string;
  readonly triggerAppearance?: SplitButtonAppearance;
  readonly triggerVariant?: SplitButtonVariant;
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

interface SplitButtonMenuParts {
  readonly menu: TemplateResult;
  readonly tooltip: TemplateResult;
}

/**
 * The caret half of a split button: a `<wa-dropdown>` with a chevron trigger
 * plus its `<wa-tooltip>`. The caller renders the main action button, owns the
 * split-button container, and decides whether the menu renders at all.
 */
export function renderSplitButtonMenu(
  options: SplitButtonMenuOptions,
): TemplateResult {
  const { menu, tooltip } = renderSplitButtonMenuParts(options);
  return html`${menu}${tooltip}`;
}

/**
 * Returns the dropdown and tooltip separately for a native
 * `<wa-button-group>` caller, which must keep the tooltip outside the group so
 * the dropdown remains its trailing segment.
 */
export function renderSplitButtonMenuParts({
  classPrefix,
  triggerId,
  triggerAriaLabel,
  triggerAppearance = 'plain',
  triggerVariant = 'neutral',
  tooltip,
  items,
  onSelect,
}: SplitButtonMenuOptions): SplitButtonMenuParts {
  return {
    menu: html`
      <wa-dropdown
        class="${classPrefix}-menu split-button-menu"
        placement="bottom-end"
        @wa-select=${(event: CustomEvent<{ item: HTMLElement }>) =>
          onSelect(
            (event.detail?.item as HTMLElement & { value?: string })?.value ??
              '',
          )}
      >
        <wa-button
          id=${triggerId}
          slot="trigger"
          class="${classPrefix}-trigger split-button-trigger"
          appearance=${triggerAppearance}
          variant=${triggerVariant}
          size="s"
          type="button"
          aria-label=${triggerAriaLabel}
        >
          ${waIcon('chevron-down')}
        </wa-button>
        ${items}
      </wa-dropdown>
    `,
    tooltip: html`<wa-tooltip for=${triggerId}>${tooltip}</wa-tooltip>`,
  };
}
