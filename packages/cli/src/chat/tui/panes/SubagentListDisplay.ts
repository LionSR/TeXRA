export function childStatusColor(status: string | undefined): string {
  if (!status) return 'green';
  if (status === 'waiting' || status === 'idle') return 'yellow';
  if (status === 'error' || status === 'stopped') return 'red';
  return 'green';
}

// A steady marker — intentionally NOT animated. A blinking dot forced the whole
// live region (including the stable Todos/Plan panel below it) to repaint twice
// a second for the entire lifetime of a long-running async subagent, and Ink's
// non-alt-screen repaint can leave stale glyphs behind on those reprints. Status
// is conveyed by `childStatusColor`, and liveness by the `running · Ns` text, so
// the animation bought churn without information.
export function childStatusMarker(): string {
  return '● ';
}
