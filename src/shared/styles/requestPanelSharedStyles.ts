/**
 * Shared CSS for all request panel components (approval, bash, retry,
 * workflow proposal, plan approval, external inquiry, and user question
 * panels), plus the parent `RequestPanels` orchestrator.
 *
 * Split out of the former single `requestPanelStyles.ts` so each panel
 * component can compose only its own styles plus this shared core,
 * instead of a single ~1000-line stylesheet. Holds:
 *  - The PANEL_TYPES-driven selector-group machinery (`selectorGroup`,
 *    `CONTAINERS`/`HEADERS`/`LISTS`/`ITEMS`/`DETAILS`/`ACTIONS`/etc.) and
 *    the `sp` spacing aliases, both consumed by the css below and
 *    re-exported (`sp`) for the per-panel style modules.
 *  - Shared layout rules that apply across all panel types.
 *  - Rejection feedback rules (shared across panels with feedback support).
 *  - The external-inquiry carousel nav/counter, rendered directly by
 *    `RequestPanels.ts` (the parent), not by `ExternalInquiryPanel`.
 *  - The short-viewport (max-height: 900px) cap on `SCROLLABLE_DETAILS`,
 *    which applies to every panel type's `__details` (except workflow
 *    proposal) and so must live here rather than in
 *    `ExternalInquiryPanel.styles.ts` alongside its sibling media rules.
 */

import { css, unsafeCSS, type CSSResult } from 'lit';

import { truncateTextRule } from './commonViewStyles';

/**
 * Shared selector groups for :is() consolidation.
 * To add a new request panel type, add an entry to the PANEL_TYPES table below
 * and the shared layout, accent, and icon rules all follow automatically.
 */

/**
 * Single source of truth for request panel types. Each entry pairs the outer
 * container class (plural), the item class (singular, used for cards and BEM
 * children), and the accent color used for the item's left border and its
 * matching header icon. Add a panel type here and the shared layout, accent,
 * and icon rules all follow — no parallel arrays to keep in sync.
 */
const PANEL_TYPES = [
  {
    container: 'approval-requests',
    item: 'approval-request',
    accent: 'var(--wa-color-text-normal)',
  },
  {
    container: 'bash-approval-requests',
    item: 'bash-approval-request',
    accent: 'var(--wa-color-terminal-ansi-yellow)',
  },
  {
    container: 'retry-requests',
    item: 'retry-request',
    accent: 'var(--color-warning)',
  },
  {
    container: 'workflow-proposals',
    item: 'workflow-proposal',
    accent: 'var(--wa-color-text-link)',
  },
  {
    container: 'plan-approval-requests',
    item: 'plan-approval-request',
    accent: 'var(--wa-color-text-link)',
  },
  {
    container: 'external-inquiry-requests',
    item: 'external-inquiry-request',
    accent: 'var(--wa-color-focus)',
  },
  {
    container: 'user-question-requests',
    item: 'user-question-request',
    accent: 'var(--wa-color-focus)',
  },
] as const;

/** Container class names (plural, used as the outer wrapper). */
const CONTAINER_NAMES = PANEL_TYPES.map((p) => p.container);

/** Item class names (singular, used for individual cards and BEM children). */
const ITEM_NAMES = PANEL_TYPES.map((p) => p.item);

/** Build a :is()-ready selector group from class names with an optional BEM suffix. */
function selectorGroup(names: readonly string[], suffix = ''): CSSResult {
  return unsafeCSS(names.map((n) => `.${n}${suffix}`).join(', '));
}

const CONTAINERS = selectorGroup(CONTAINER_NAMES);
const HEADERS = selectorGroup(CONTAINER_NAMES, '__header');
const LISTS = selectorGroup(CONTAINER_NAMES, '__list');
const ITEMS = selectorGroup(ITEM_NAMES);
const DETAILS = selectorGroup(ITEM_NAMES, '__details');
const ACTIONS = selectorGroup(ITEM_NAMES, '__actions');
const FEEDBACKS = selectorGroup(ITEM_NAMES, '__feedback');
const FEEDBACK_INPUTS = selectorGroup(ITEM_NAMES, '__feedback-input');
const FEEDBACK_ACTIVE = selectorGroup(ITEM_NAMES, '--feedback-active');
const SCROLLABLE_DETAILS = selectorGroup(
  ITEM_NAMES.filter((n) => n !== 'workflow-proposal'),
  '__details',
);

/** Per-type accent rules: item left-border plus matching header icon color. */
const ACCENT_RULES = unsafeCSS(
  PANEL_TYPES.map(
    ({ item, container, accent }) =>
      `.${item} {
    border-left: var(--border-medium) solid ${accent};
  }
  .${container}__header wa-icon {
    color: ${accent};
  }`,
  ).join('\n  '),
);

export const sp = {
  tiny: unsafeCSS('var(--wa-space-3xs)'),
  small: unsafeCSS('var(--wa-space-2xs)'),
  medium: unsafeCSS('var(--wa-space-xs)'),
  large: unsafeCSS('var(--wa-space-s)'),
  xlarge: unsafeCSS('var(--wa-space-l)'),
} as const;

export const requestPanelSharedStyles: CSSResult = css`
  /* ================================================================
   * Shared request panel layout (all panel types)
   * ================================================================ */

  :host {
    box-sizing: border-box;
    min-width: 0;
    max-width: 100%;
  }

  :is(${CONTAINERS}) {
    margin: ${sp.medium} 0;
    padding: ${sp.medium};
    border: var(--border-thin) solid var(--wa-form-control-border-color);
    border-radius: var(--border-radius-large);
    background: var(--wa-color-surface-default);
    display: flex;
    flex-direction: column;
    gap: ${sp.medium};
    box-sizing: border-box;
    min-width: 0;
    max-width: 100%;
  }

  :is(${HEADERS}) {
    display: flex;
    align-items: center;
    gap: ${sp.medium};
    font-weight: var(--font-weight-semibold);
    color: var(--wa-color-text-normal);
  }

  :is(${LISTS}) {
    display: flex;
    flex-direction: column;
    gap: ${sp.medium};
    min-width: 0;
    max-width: 100%;
  }

  :is(${ITEMS}) {
    display: flex;
    flex-direction: column;
    border-radius: var(--border-radius);
    border: var(--border-thin) solid var(--wa-color-surface-border);
    background: var(--wa-color-surface-raised);
    padding: ${sp.medium};
    gap: ${sp.medium};
    position: relative;
    box-sizing: border-box;
    min-width: 0;
    max-width: 100%;
  }

  :is(${DETAILS}) {
    display: flex;
    flex-direction: column;
    gap: ${sp.small};
  }

  /* Scroll constraint for panels with potentially long content.
     Excluded: workflow-proposal__details (has an absolutely-positioned
     dropdown that would be clipped by overflow-y: auto). */
  :is(${SCROLLABLE_DETAILS}) {
    max-height: min(34vh, 26rem);
    overflow-y: auto;
    scrollbar-gutter: stable;
  }

  .approval-request__meta,
  .retry-request__meta {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    display: flex;
    align-items: center;
    gap: ${sp.small};
    flex-wrap: wrap;
  }

  :is(${ACTIONS}) {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: ${sp.small};
    min-width: 0;
    max-width: 100%;
  }

  :is(${ACTIONS}) > * {
    min-width: 0;
    max-width: 100%;
  }

  /* The primary action buttons hug their content and stay button-sized: they
     never grow to fill a wide panel and are width-capped, so they group at the
     start of the row instead of stretching, and the label centers within the
     button's own padding. min-width: auto restores the flex min-content floor
     (overriding the bounded-children min-width: 0 above), so a button never
     shrinks below its own label and wraps to the next row instead of
     clipping. Keyed off the semantic .action-button class the button helper
     sets in its template (not the data-action behaviour hook) and sized on the
     host element, so there is no shadow-part piercing and no source-order
     tiebreak to keep in sync. Tool edit approvals override with their bespoke
     sizing below, winning by specificity. */
  :is(${ACTIONS}) .action-button {
    flex: 0 1 auto;
    min-width: auto;
    max-width: min(14rem, 100%);
  }

  .approval-request__actions wa-button[data-action] {
    flex: 0 1 7rem;
    width: auto;
    min-width: min(5.5rem, 100%);
    max-width: min(7rem, 100%);
  }

  .approval-request__actions wa-button[data-action]::part(base) {
    justify-content: center;
    width: 100%;
    inline-size: 100%;
    min-width: 0;
    max-width: 100%;
  }

  .approval-request__actions wa-button[data-action]::part(label),
  .approval-request__actions .diff-dropdown .diff-main-button::part(label) {
    min-width: 0;
    ${truncateTextRule}
  }

  /* Shared action button colors */
  :is(${ACTIONS}) wa-button[data-action='approve']::part(base),
  :is(${ACTIONS}) wa-button[data-action='submit']::part(base) {
    color: var(--wa-color-success-fill-loud);
  }

  :is(${ACTIONS}) wa-button[data-action='setup']::part(base) {
    color: var(--wa-color-text-link);
  }

  :is(${FEEDBACK_ACTIVE})
    :is(${ACTIONS})
    wa-button[data-action='reject']::part(base) {
    color: var(--wa-color-warning-border-quiet);
  }

  /* Type-specific item accent + matching header icon color (see PANEL_TYPES / ACCENT_RULES) */
  ${ACCENT_RULES}

  /* Rejection feedback (shared across panels with feedback support) */
  :is(${FEEDBACKS}) {
    margin-top: ${sp.small};
  }

  :is(${FEEDBACK_INPUTS}) {
    width: 100%;
  }

  /* Carousel navigation for multiple external inquiries (rendered directly by
     RequestPanels.ts, not by ExternalInquiryPanel). */
  .external-inquiry-requests__nav {
    display: flex;
    align-items: center;
    gap: ${sp.small};
    margin-left: auto;
  }

  .external-inquiry-requests__counter {
    font-size: var(--font-size-sm);
    color: var(--wa-color-text-quiet);
    font-variant-numeric: tabular-nums;
    min-width: 3ch;
    text-align: center;
  }

  /* Short-viewport cap shared by every scrollable panel body (see
     SCROLLABLE_DETAILS above); the external-inquiry-specific media rules
     that used to share this block live in ExternalInquiryPanel.styles.ts. */
  @media (max-height: 900px) {
    :is(${SCROLLABLE_DETAILS}) {
      max-height: min(28vh, 20rem);
    }
  }
`;
