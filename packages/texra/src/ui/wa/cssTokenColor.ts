/**
 * Resolve CSS colour tokens to `#rrggbbaa` hex as an element under `target`
 * paints them.
 *
 * A custom property reads back as the text it was declared with, so a token
 * declared `light-dark(a, b)`, `color-mix(...)` or through a system colour is
 * not yet a colour a canvas-drawn widget (xterm.js, Monaco) can parse. Each
 * token is resolved as the computed `color` of a probe under `target`, then
 * serialized through a 1×1 canvas, which accepts every CSS colour syntax.
 *
 * A token `target` does not define resolves to `undefined`, never to the
 * inherited colour an undefined `var()` would compute to: the caller decides
 * whether that is a host bug to report or a key to leave at its default.
 */
export function cssTokenColors(
  target: Element,
): (token: string) => string | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('Could not create a canvas to resolve theme colours.');
  }
  const declared = getComputedStyle(target);
  const resolved = new Map<string, string>();
  return (token) => {
    const cached = resolved.get(token);
    if (cached) return cached;
    if (!declared.getPropertyValue(token).trim()) return undefined;
    // Set the complete style before connecting the probe. Reusing a connected
    // probe can return its previous computed color in the offscreen renderer.
    const probe = document.createElement('span');
    probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;color:var(${token})`;
    target.append(probe);
    try {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = getComputedStyle(probe).color;
      context.fillRect(0, 0, 1, 1);
    } finally {
      probe.remove();
    }
    const value =
      '#' +
      [...context.getImageData(0, 0, 1, 1).data]
        .map((channel) => channel.toString(16).padStart(2, '0'))
        .join('');
    resolved.set(token, value);
    return value;
  };
}
