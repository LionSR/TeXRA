// Empty and loading placeholders, one look in every host: the hero
// (`renderEmptyState`: icon, title, optional body), its `is-compact` form for
// a narrow pane, the one line a list shows when it has nothing to list
// (`renderEmptyMessage`), and the spinner line `renderLoadingState` draws.
// Components get the sheet through commonViewStyles; the desktop adopts it
// for its light DOM. A consumer adds only where the placeholder sits.

import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { css, html, nothing, type CSSResult, type TemplateResult } from 'lit';
import { html as staticHtml, literal } from 'lit/static-html.js';

import type { IconName } from '@ui/wa/iconNames';
import { waIcon } from './webAwesomeIcons';

export const placeholderStyles: CSSResult = css`
  .empty-state {
    display: grid;
    justify-items: center;
    align-content: center;
    gap: var(--wa-space-xs);
    box-sizing: border-box;
    min-width: 0;
    padding: var(--wa-space-l);
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size-sm);
    text-align: center;
  }

  .empty-state-icon {
    font-size: var(--font-size-h1);
  }

  .empty-state-title {
    margin: 0;
    font-size: var(--font-size);
    font-weight: var(--font-weight-semibold);
    color: var(--wa-color-text-normal);
  }

  .empty-state-body {
    margin: 0;
    max-width: 36ch;
  }

  .empty-state.is-compact {
    gap: var(--wa-space-2xs);
    padding: var(--wa-space-m);
  }

  .empty-state.is-compact .empty-state-icon {
    font-size: var(--font-size-lg);
  }

  .empty-state.is-compact .empty-state-title {
    font-size: inherit;
    font-weight: inherit;
    color: inherit;
  }

  .empty-message {
    margin: 0;
    padding: var(--wa-space-xs) var(--wa-space-s);
    color: var(--wa-color-text-quiet);
    font-size: var(--font-size-sm);
    text-align: center;
  }

  .loading-state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--wa-space-xs);
    padding: var(--wa-space-l);
    color: var(--wa-color-text-quiet);
  }
`;

type EmptyStateHeadingTag = 'h1' | 'h2' | 'h3';

interface EmptyStateOptions {
  readonly icon: IconName;
  readonly title: string;
  readonly body?: string;
  /** Extra classes: `is-compact`, or the consumer's placement hook. */
  readonly className?: string;
  // Defaults to 'h2'. Callers that own the surrounding semantic outline can
  // promote (h1) or demote (h3) the title without forking the helper.
  readonly headingTag?: EmptyStateHeadingTag;
}

const HEADING_TAGS = {
  h1: literal`h1`,
  h2: literal`h2`,
  h3: literal`h3`,
} as const satisfies Record<EmptyStateHeadingTag, ReturnType<typeof literal>>;

export function renderEmptyState({
  icon,
  title,
  body,
  className,
  headingTag = 'h2',
}: EmptyStateOptions): TemplateResult {
  const tag = HEADING_TAGS[headingTag];
  const iconGlyph = waIcon(icon, { className: 'empty-state-icon' });
  // staticHtml + literal lets the heading element stay parameterizable
  // (semantic outline) while keeping interpolated children type-checked.
  return staticHtml`
    <section class=${className ? `empty-state ${className}` : 'empty-state'}>
      ${iconGlyph}
      <${tag} class="empty-state-title">${title}</${tag}>
      ${body ? html`<p class="empty-state-body">${body}</p>` : nothing}
    </section>
  `;
}

/** The one line a list or pane shows when it has nothing to show. A status
 *  region, so a filter that empties the list is announced. */
export function renderEmptyMessage(text: string): TemplateResult {
  return html`<p class="empty-message" role="status">${text}</p>`;
}
