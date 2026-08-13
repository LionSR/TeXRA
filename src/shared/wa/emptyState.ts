// Hero empty-state pattern shared between hosts. Consumers style via the
// .empty-state-* class hooks; the helper owns the structure.

import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { html, nothing, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import { html as staticHtml, literal } from 'lit/static-html.js';

import { waIcon } from './webAwesomeIcons';
import type { TeXRAIconName } from './iconNames';

interface EmptyStateAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly appearance?: 'filled' | 'outlined';
  readonly variant?: 'brand' | 'neutral';
  // Defaults to 'm' (the <wa-button> default). Lets compact panels
  // (e.g. a getting-started row packed with several actions) opt into
  // 's' without forking the helper.
  readonly size?: 's' | 'm';
  // Forwarded onto the underlying <wa-button>. Lets callers re-apply host-
  // specific semantic button classes (e.g. btn-primary) for theming hooks.
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
  // Note: providing a kicker replaces the icon leader — the main `icon` glyph
  // (and any `iconSurfaceSize` wrapper) is not rendered; the kicker row reuses
  // only the icon name.
  readonly kicker?: string;
  // Icon used inside the kicker. Defaults to the main `icon` prop so the
  // helper stays minimal when callers want a simple eyebrow.
  readonly kickerIcon?: TeXRAIconName;
  // Wraps the main icon in the shared `.icon-surface` decorative box (same
  // contract as settingsBanner.ts) at the given size, instead of the bare
  // glyph. Omit for the default bare-icon treatment. Inert when `kicker` is
  // set — the kicker row replaces the icon leader.
  readonly iconSurfaceSize?: 's' | 'm' | 'l';
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
  iconSurfaceSize,
}: EmptyStateOptions): TemplateResult {
  const tag = HEADING_TAGS[headingTag];
  const iconGlyph = waIcon(icon, { className: 'empty-state-icon' });
  const surfacedIcon = iconSurfaceSize
    ? html`
        <span
          class="empty-state-icon-surface icon-surface is-size-${iconSurfaceSize}"
        >
          ${iconGlyph}
        </span>
      `
    : iconGlyph;
  // Either the kicker row (when `kicker` is set, which replaces the main icon)
  // or the main icon leader (`surfacedIcon`). The substitution is intentional:
  // a badge-style kicker is the eyebrow treatment, so both are never rendered.
  const iconOrKicker = kicker
    ? html`
        <div class="empty-state-kicker">
          ${waIcon(kickerIcon ?? icon, {
            className: 'empty-state-kicker-icon',
          })}
          <span>${kicker}</span>
        </div>
      `
    : surfacedIcon;
  // staticHtml + literal lets the heading element stay parameterizable
  // (semantic outline) while keeping interpolated children type-checked.
  return staticHtml`
    <section class=${ifDefined(className)}>
      ${iconOrKicker}
      <${tag} class="empty-state-title">${title}</${tag}>
      ${body ? html`<p class="empty-state-body">${body}</p>` : nothing}
      ${
        actions?.length
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
