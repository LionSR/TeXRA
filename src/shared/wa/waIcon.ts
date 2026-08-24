/**
 * The `<wa-icon>` Lit template helper — UI-only, icon-data-free.
 *
 * Kept separate from `webAwesomeIcons.ts` so a host that supplies its own
 * icon-library resolver (desktop, via `desktopIconLibrary.ts`'s Lucide
 * resolver) can render icons without importing the ~135 Font Awesome path-data
 * modules that `webAwesomeIcons.ts` registers for hosts using the FA resolver.
 */

import { html, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';

import type { TeXRAIconName } from './iconNames';

export const TEXRA_ICON_LIBRARY = 'texra';

interface WaIconOptions {
  readonly id?: string;
  // 'start' / 'end' for wa-button; 'icon' for wa-callout / wa-card.
  readonly slot?: 'start' | 'end' | 'icon';
  readonly className?: string;
  readonly variant?: 'solid' | 'regular';
  readonly label?: string;
  // Native `title` tooltip. Purely visual — a decorative icon with a hover
  // tooltip stays `aria-hidden` (only `label` exposes it to assistive tech).
  readonly title?: string;
}

// Lit template for <wa-icon>. Decorative icons stay hidden from assistive
// technology; icon-only controls pass a label as required by Web Awesome.
export function waIcon(
  name: TeXRAIconName,
  options: WaIconOptions = {},
): TemplateResult {
  return html`<wa-icon
    id=${ifDefined(options.id)}
    library=${TEXRA_ICON_LIBRARY}
    name=${name}
    variant=${options.variant ?? 'solid'}
    canvas="auto"
    slot=${ifDefined(options.slot)}
    class=${ifDefined(options.className)}
    label=${ifDefined(options.label)}
    title=${ifDefined(options.title)}
    aria-hidden=${ifDefined(options.label == null ? 'true' : undefined)}
  ></wa-icon>`;
}
