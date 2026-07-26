// Numeric typography bridge for canvas-based desktop surfaces.
//
// Most renderer UI consumes the CSS type scale directly. Monaco and xterm
// require numeric options, so resolve the inherited desktop chrome size once
// from the same computed style instead of maintaining separate magic numbers.

const FALLBACK_CHROME_FONT_SIZE = 13;

/** Returns the resolved desktop chrome font size in CSS pixels. */
export function getDesktopChromeFontSize(): number {
  const fontSize = Number.parseFloat(getComputedStyle(document.body).fontSize);
  return Number.isFinite(fontSize) && fontSize > 0
    ? fontSize
    : FALLBACK_CHROME_FONT_SIZE;
}
