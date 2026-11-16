/**
 * The items of a `<wa-dropdown>` of actions, and the one `@wa-select`
 * handler that runs the picked one. Each item carries what it does, so an
 * item is written once: the dropdown names items by position, and nothing
 * decodes a value string back into an action.
 */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import type { WaSelectEvent } from '@awesome.me/webawesome/dist/events/events.js';

// Local imports
import type { IconName } from './iconNames';
import { afterDropdownHides, selectedItemValue } from './selectTemplates';
import { waIcon } from './webAwesomeIcons';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';

/** One action in a dropdown menu. */
export interface ActionMenuItem {
  readonly icon?: IconName;
  readonly label: string;
  readonly variant?: 'danger';
  /** A divider separates this item from the ones above it. */
  readonly dividerBefore?: boolean;
  readonly disabled?: boolean;
  /** The action focuses something of its own (an inline rename field), so
   *  it starts once the dropdown has hidden and moved focus back. */
  readonly focusesOwn?: boolean;
  readonly activate: () => void;
}

/** The dropdown's items, and the handler its `@wa-select` binds. */
export function actionMenu(items: readonly ActionMenuItem[]): {
  readonly items: TemplateResult;
  readonly onSelect: (event: WaSelectEvent) => void;
} {
  return {
    items: html`${items.map(
      (item, index) =>
        html`${item.dividerBefore ? html`<wa-divider></wa-divider>` : nothing}<wa-dropdown-item
            value=${index}
            variant=${item.variant ?? nothing}
            ?disabled=${item.disabled ?? false}
            >${item.icon ? waIcon(item.icon, { slot: 'icon' }) : nothing}${item.label}</wa-dropdown-item
          >`,
    )}`,
    onSelect: (event) => {
      const value = selectedItemValue(event);
      const item = value === '' ? undefined : items[Number(value)];
      if (item === undefined) return;
      if (item.focusesOwn) afterDropdownHides(event, item.activate);
      else item.activate();
    },
  };
}
