/**
 * The Web Awesome semantic-variant vocabulary (`variant` on `wa-callout`,
 * `wa-tag` and `wa-badge`). One owner so the banner, tag and status chrome
 * cannot drift on which variants exist, the way `iconNames` owns the icon set.
 */
export type WaVariant = 'brand' | 'neutral' | 'success' | 'warning' | 'danger';
