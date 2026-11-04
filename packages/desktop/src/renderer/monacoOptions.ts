import type { editor } from 'monaco-editor/editor/editor.api.js';

/** Shared typography and gutter geometry for source and diff editors. */
export function monacoPresentationOptions(
  target: HTMLElement,
): editor.IEditorOptions {
  const styles = getComputedStyle(target);
  const fontSize =
    Number.parseFloat(styles.getPropertyValue('--wa-editor-font-size')) ||
    Number.parseFloat(styles.getPropertyValue('--font-size-reading')) ||
    14;
  return {
    fontSize,
    fontFamily: styles.getPropertyValue('--wa-font-family-mono'),
    fontLigatures: false,
    lineHeight: Math.round(fontSize * 1.5),
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    lineNumbersMinChars: 4,
    lineDecorationsWidth: 8,
    glyphMargin: false,
    padding: { top: 8, bottom: 8 },
    renderLineHighlight: 'none',
    stickyScroll: { enabled: false },
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    scrollbar: {
      verticalScrollbarSize: 8,
      horizontalScrollbarSize: 8,
      useShadows: false,
    },
    smoothScrolling: false,
    cursorBlinking: 'blink',
    fixedOverflowWidgets: true,
    // Desktop owns the editor's shared stylesheet. Keep popups in that same
    // document so menu and hover styling follows the host theme as well.
    useShadowDOM: false,
  };
}
