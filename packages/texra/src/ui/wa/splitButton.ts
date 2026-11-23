// Third-party imports
import {
  css,
  html,
  type CSSResult,
  type nothing,
  type TemplateResult,
} from 'lit';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';

// Local imports - Web Awesome
import { renderIconActionButtonParts } from './actionButtons';
import { actionMenu, type ActionMenuItem } from './actionMenu';

interface SplitButtonMenuOptions {
  /** Component-specific prefix for the menu and caret-trigger classes. */
  readonly classPrefix: string;
  /** Trigger button id; the tooltip anchors to it via `for`. */
  readonly triggerId: string;
  readonly triggerAriaLabel: string;
  readonly tooltip: string;
  /** The menu's actions. */
  readonly items: readonly ActionMenuItem[];
}

interface SplitButtonMenuParts {
  readonly menu: TemplateResult;
  readonly tooltip: TemplateResult | typeof nothing;
}

/**
 * Styling for the caret trigger `renderSplitButtonMenuParts` emits, keyed on
 * the fixed `.split-trigger`/`.split-menu` classes the template below also
 * emits. Its caller is the request card's run-grant menu (`BaseRequestPanel`).
 */
export const splitButtonTriggerStyles: CSSResult = css`
  .split-trigger {
    width: 1.5rem;
    min-width: 1.5rem;
  }

  .split-trigger::part(base) {
    padding-inline: 0;
  }

  .split-trigger wa-icon {
    font-size: var(--font-size-sm);
    transition: transform var(--transition-fast);
  }

  .split-menu[open] .split-trigger wa-icon {
    transform: rotate(180deg);
  }

  @media (prefers-reduced-motion: reduce) {
    .split-trigger wa-icon {
      transition: none;
    }
  }
`;

/**
 * Returns the dropdown and tooltip separately for a native
 * `<wa-button-group>` caller, which must keep the tooltip outside the group so
 * the dropdown remains its trailing segment. The caret trigger wears the
 * primary (accent, brand) skin of the main button it extends.
 */
export function renderSplitButtonMenuParts({
  classPrefix,
  triggerId,
  triggerAriaLabel,
  tooltip,
  items,
}: SplitButtonMenuOptions): SplitButtonMenuParts {
  const menu = actionMenu(items);
  const trigger = renderIconActionButtonParts({
    id: triggerId,
    slot: 'trigger',
    className: `${classPrefix}-trigger split-trigger`,
    icon: 'chevron-down',
    label: triggerAriaLabel,
    tooltip,
    splitMain: true,
  });
  return {
    menu: html`
      <wa-dropdown
        class="${classPrefix}-menu split-menu"
        placement="bottom-end"
        @wa-select=${menu.onSelect}
      >
        ${trigger.button} ${menu.items}
      </wa-dropdown>
    `,
    tooltip: trigger.tooltip,
  };
}
