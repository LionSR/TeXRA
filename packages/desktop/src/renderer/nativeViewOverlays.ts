/** Native browser views sit above DOM popovers, so cover them while a menu is open. */
export function trackNativeViewOverlays(onChange: () => void) {
  const open = new Set<HTMLElement>();
  const target = (event: Event) =>
    event
      .composedPath()
      .find(
        (node): node is HTMLElement =>
          node instanceof HTMLElement && node.matches('wa-dropdown, wa-dialog'),
      );
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
