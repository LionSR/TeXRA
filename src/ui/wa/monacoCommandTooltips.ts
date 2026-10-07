/**
 * Monaco mounts command descriptions inside its clipped editor widget.
 * Promote just those descriptions to the browser's top layer, anchored to
 * their command row. Monaco retains content, keyboard behavior and disposal.
 */
export function installMonacoCommandTooltips(
  container: HTMLElement,
): () => void {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const popup =
          node.closest<HTMLElement>('.context-view') ??
          node.querySelector<HTMLElement>('.context-view');
        const list = popup?.closest('.quick-input-list');
        if (
          !popup ||
          !list ||
          popup.popover ||
          !popup.querySelector('.workbench-hover')
        )
          continue;
        const anchor =
          list.querySelector<HTMLElement>('.monaco-list-row:hover') ??
          list.querySelector<HTMLElement>('.monaco-list-row.focused');
        if (!anchor || !popup.isConnected) continue;
        popup.classList.add('texra-command-tooltip');
        popup.popover = 'manual';
        popup.showPopover({ source: anchor });
      }
    }
  });
  observer.observe(container, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    for (const popup of container.querySelectorAll<HTMLElement>(
      '.texra-command-tooltip:popover-open',
    ))
      popup.hidePopover();
  };
}
