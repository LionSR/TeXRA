import type { Theme } from '@texra/shared/ipc';
import { cssTokenColors } from '@ui/wa/cssTokenColor';
import {
  monacoThemeForHostTheme,
  type MonacoModule,
} from '@ui/monaco/monacoLoader';

/** Bridge the host palette to Monaco's editor, search, menus and suggestions. */
export function applyMonacoTheme(
  monaco: MonacoModule,
  theme: Theme,
  target: HTMLElement,
): string {
  const base = monacoThemeForHostTheme(theme);
  if (base === 'hc-black') {
    monaco.editor.setTheme(base);
    return base;
  }
  // Monaco accepts hex colors only, and reads an unparsable one as red, so a
  // token the host does not define leaves its key out: the base theme's value
  // stands.
  const color = cssTokenColors(target);
  const foreground = color('--wa-color-text-normal');
  const quiet = color('--wa-color-text-quiet');
  const surface = color('--wa-color-surface-default');
  const border = color('--wa-color-surface-border');
  const accent = color('--wa-color-focus');
  const selected = color('--wa-color-brand-fill-quiet');
  const menu = color('--wa-color-menu-background');
  const name = `texra-${base}`;
  monaco.editor.defineTheme(name, {
    base,
    inherit: true,
    rules: [
      { token: 'comment', foreground: quiet?.slice(1, 7) },
      { token: 'keyword', foreground: accent?.slice(1, 7) },
    ],
    colors: Object.fromEntries(
      Object.entries({
        foreground,
        focusBorder: accent,
        'widget.border': border,
        'widget.shadow': color('--wa-color-surface-shadow'),
        'editor.background': surface,
        'editor.foreground': foreground,
        'editorGutter.background': surface,
        'editorLineNumber.foreground': quiet,
        'editorLineNumber.activeForeground': foreground,
        'editorCursor.foreground': accent,
        'editor.selectionBackground': color('--wa-color-editor-selection'),
        'editor.inactiveSelectionBackground': color(
          '--wa-color-editor-inactive-selection',
        ),
        'diffEditor.insertedTextBackground': color('--wa-color-diff-inserted'),
        'diffEditor.removedTextBackground': color('--wa-color-diff-removed'),
        'diffEditor.insertedLineBackground': color('--wa-color-diff-inserted'),
        'diffEditor.removedLineBackground': color('--wa-color-diff-removed'),
        'editor.lineHighlightBorder': '#00000000',
        'editor.findMatchBackground': color('--wa-color-editor-find-match'),
        'editor.findMatchHighlightBackground': color(
          '--wa-color-editor-find-match-highlight',
        ),
        'editorWidget.background': menu,
        'editorWidget.foreground': foreground,
        'editorWidget.border': border,
        'editorWidget.resizeBorder': accent,
        'editorSuggestWidget.background': menu,
        'editorSuggestWidget.border': border,
        'editorSuggestWidget.foreground': foreground,
        'editorSuggestWidget.selectedBackground': selected,
        'editorSuggestWidget.selectedForeground': foreground,
        'editorSuggestWidget.highlightForeground': accent,
        'editorHoverWidget.background': menu,
        'editorHoverWidget.foreground': foreground,
        'editorHoverWidget.border': border,
        'quickInput.background': menu,
        'quickInput.foreground': foreground,
        'quickInputTitle.background': menu,
        'quickInputList.focusBackground': selected,
        'quickInputList.focusForeground': foreground,
        'quickInputList.focusIconForeground': foreground,
        'quickInputList.focusHighlightForeground': accent,
        'input.background': color('--wa-form-control-background-color'),
        'input.foreground': foreground,
        'input.border': color('--wa-form-control-border-color'),
        'input.placeholderForeground': quiet,
        'inputOption.activeBackground': selected,
        'inputOption.activeBorder': accent,
        'inputOption.activeForeground': foreground,
        'list.focusBackground': selected,
        'list.focusForeground': foreground,
        'list.activeSelectionBackground': selected,
        'list.activeSelectionForeground': foreground,
        'list.inactiveSelectionBackground': selected,
        'list.hoverBackground': color('--wa-color-surface-raised'),
        'list.highlightForeground': accent,
        'list.focusOutline': '#00000000',
        'menu.background': menu,
        'menu.foreground': foreground,
        'menu.border': border,
        'menu.selectionBackground': selected,
        'menu.selectionForeground': foreground,
        'menu.separatorBackground': border,
        'keybindingLabel.background': color('--wa-color-surface-lowered'),
        'keybindingLabel.foreground': quiet,
        'keybindingLabel.border': border,
        'keybindingLabel.bottomBorder': border,
      }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  });
  monaco.editor.setTheme(name);
  return name;
}
