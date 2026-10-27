// Hero empty-state pattern shared between hosts. Consumers style via the
// .empty-state-* class hooks; the helper owns the structure.

import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { html, nothing, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import { html as staticHtml, literal } from 'lit/static-html.js';

import type { IconName } from '@ui/wa/iconNames';
import { waIcon } from './webAwesomeIcons';

type EmptyStateHeadingTag = 'h1' | 'h2' | 'h3';

export interface EmptyStateOptions {
  readonly icon: IconName;
  readonly title: string;
  readonly body?: string;
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
    <section class=${ifDefined(className)}>
      ${iconGlyph}
      <${tag} class="empty-state-title">${title}</${tag}>
      ${body ? html`<p class="empty-state-body">${body}</p>` : nothing}
    </section>
  `;
}
