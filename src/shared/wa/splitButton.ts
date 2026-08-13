// Third-party imports
import { html, type TemplateResult } from 'lit';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - Web Awesome
import { waIcon } from './webAwesomeIcons';
import type { WaSelectEvent } from '@awesome.me/webawesome/dist/events/events.js';
import type { IconActionButtonOptions } from './actionButtons';

interface SplitButtonMenuOptions {
  /** Component-specific prefix for the menu and caret-trigger classes. */
  readonly classPrefix: string;
  /** Trigger button id; the tooltip anchors to it via `for`. */
  readonly triggerId: string;
  readonly triggerAriaLabel: string;
  readonly triggerAppearance?: IconActionButtonOptions['appearance'];
  readonly triggerVariant?: IconActionButtonOptions['variant'];
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

function selectedItemValue(event: WaSelectEvent): string {
  const { item } = event.detail;
  if (item.localName !== 'wa-dropdown-item' || !('value' in item)) return '';
  return typeof item.value === 'string' ? item.value : '';
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
        class="${classPrefix}-menu"
        placement="bottom-end"
        @wa-select=${(event: WaSelectEvent) =>
          onSelect(selectedItemValue(event))}
      >
        <wa-button
          id=${triggerId}
          slot="trigger"
          class="${classPrefix}-trigger"
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
