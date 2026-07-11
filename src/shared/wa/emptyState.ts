// Hero empty-state pattern shared between hosts. Consumers style via the
// .empty-state-* class hooks; the helper owns the structure.

import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { html, nothing, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import { html as staticHtml, literal } from 'lit/static-html.js';

import { waIcon, type TeXRAIconName } from './webAwesomeIcons';

interface EmptyStateAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly appearance?: 'filled' | 'outlined';
  readonly variant?: 'brand' | 'neutral';
  // Defaults to 'medium' (the <wa-button> default). Lets compact panels
  // (e.g. a getting-started row packed with several actions) opt into
  // 'small' without forking the helper.
  readonly size?: 'small' | 'medium';
  // Forwarded onto the underlying <wa-button>. Lets callers re-apply host-
  // specific button classes (e.g. desktop-primary-button) for theming hooks.
  readonly className?: string;
  // Optional leading icon, rendered with slot="start" inside the button.
  // Lets callers preserve action-icon affordances (e.g. play/gear) without
  // forking the helper or dropping back to inline templates.
  readonly icon?: TeXRAIconName;
}

type EmptyStateHeadingTag = 'h1' | 'h2' | 'h3';

export interface EmptyStateOptions {
  readonly icon: TeXRAIconName;
  readonly title: string;
  readonly body?: string;
  readonly actions?: readonly EmptyStateAction[];
  readonly className?: string;
  // Defaults to 'h2'. Callers that own the surrounding semantic outline can
  // promote (h1) or demote (h3) the title without forking the helper.
  readonly headingTag?: EmptyStateHeadingTag;
  // Optional eyebrow/kicker label rendered above the title. Used by callers
  // that want a section badge (e.g. "Progress") without forking the helper.
  readonly kicker?: string;
  // Icon used inside the kicker. Defaults to the main `icon` prop so the
  // helper stays minimal when callers want a simple eyebrow.
  readonly kickerIcon?: TeXRAIconName;
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
  actions,
  className,
  headingTag = 'h2',
  kicker,
  kickerIcon,
}: EmptyStateOptions): TemplateResult {
  const tag = HEADING_TAGS[headingTag] ?? HEADING_TAGS.h2;
  // staticHtml + literal lets the heading element stay parameterizable
  // (semantic outline) while keeping interpolated children type-checked.
  return staticHtml`
    <section class=${ifDefined(className)}>
      ${
        kicker
          ? html`
              <div class="empty-state-kicker">
                ${waIcon(kickerIcon ?? icon, {
                  className: 'empty-state-kicker-icon',
                })}
                <span>${kicker}</span>
              </div>
            `
          : waIcon(icon, { className: 'empty-state-icon' })
      }
      <${tag} class="empty-state-title">${title}</${tag}>
      ${body ? html`<p class="empty-state-body">${body}</p>` : nothing}
      ${
        actions && actions.length > 0
          ? html`
              <div class="empty-state-actions">
                ${actions.map(
                  (action) => html`
                    <wa-button
                      class=${ifDefined(action.className)}
                      appearance=${action.appearance ?? 'outlined'}
                      variant=${action.variant ?? 'neutral'}
                      size=${ifDefined(action.size)}
                      @click=${action.onClick}
                    >
                      ${
                        action.icon
                          ? waIcon(action.icon, { slot: 'start' })
                          : nothing
                      }
                      ${action.label}
                    </wa-button>
                  `,
                )}
              </div>
            `
          : nothing
      }
    </section>
  `;
}
