/** Native browser views sit above DOM popovers, so cover them while a menu is open. */
export function trackNativeViewOverlays(onChange: () => void) {
  const open = new Set<HTMLElement>();
  // The overlay itself raised the event: a tooltip inside an open drawer
  // also raises `wa-after-hide`, and must not uncover the views.
  const target = (event: Event) => {
    const [origin] = event.composedPath();
    return origin instanceof HTMLElement &&
      origin.matches('wa-dropdown, wa-dialog, wa-drawer')
      ? origin
      : undefined;
  };
  document.addEventListener('wa-show', (event) => {
    const element = target(event);
    if (!element) return;
    open.add(element);
    onChange();
  });
  document.addEventListener('wa-after-hide', (event) => {
    const element = target(event);
    if (!element) return;
    open.delete(element);
    onChange();
  });
  return {
    isCovered(): boolean {
      for (const element of open) {
        if (!element.isConnected) open.delete(element);
      }
      return open.size > 0;
    },
  };
}
