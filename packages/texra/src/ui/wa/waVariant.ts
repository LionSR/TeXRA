import type { RunTone } from '@ui/copy/runStatus';

/**
 * The Web Awesome semantic-variant vocabulary (`variant` on `wa-callout`,
 * `wa-tag` and `wa-badge`). One owner so the banner, tag and status chrome
 * cannot drift on which variants exist, the way `iconNames` owns the icon set.
 */
export type WaVariant = 'brand' | 'neutral' | 'success' | 'warning' | 'danger';

/** The variant a status tone gives a badge or tag: the colour `toneStyles`
 *  gives the same tone's `tone-*` class, where a running status paints in
 *  the success green. */
export function toneVariant(tone: RunTone): WaVariant {
  return tone === 'running' ? 'success' : tone;
}
