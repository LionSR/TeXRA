/**
 * Keep Monaco's command help inside its palette. Monaco owns the help text
 * and its lifecycle; this adapter presents that text once in a footer.
 */
export function installMonacoCommandDescriptions(
  container: HTMLElement,
): () => void {
  const footers = new Map<HTMLElement, HTMLElement>();
  const observer = new MutationObserver(() => {
    for (const [widget, footer] of footers) {
      if (!widget.isConnected) {
        footer.remove();
        footers.delete(widget);
      }
    }
    for (const widget of container.querySelectorAll<HTMLElement>(
      '.quick-input-widget',
    )) {
      const popup = widget.querySelector<HTMLElement>(
        '.quick-input-list .context-view:has(.workbench-hover)',
      );
      const text =
        popup && popup.style.display !== 'none'
          ? (popup.querySelector('.hover-contents')?.textContent?.trim() ?? '')
          : '';
      let footer = footers.get(widget);
      if (!footer && text) {
        footer = document.createElement('div');
        footer.className = 'texra-command-description';
        footer.setAttribute('role', 'note');
        widget.appendChild(footer);
        footers.set(widget, footer);
      }
      if (!footer) continue;
      if (footer.textContent !== text) footer.textContent = text;
      footer.hidden = !text;
      // The footer participates in the palette's layout. Keep the complete
      // surface inside the window when an editor group is near the bottom.
      if (text && widget.getBoundingClientRect().height) {
        const maxHeight = `${Math.max(0, innerHeight - widget.getBoundingClientRect().top - 12)}px`;
        if (widget.style.maxHeight !== maxHeight)
          widget.style.maxHeight = maxHeight;
      }
    }
  });
  observer.observe(container, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['style'],
  });
  return () => {
    observer.disconnect();
    for (const footer of footers.values()) footer.remove();
    footers.clear();
  };
}
