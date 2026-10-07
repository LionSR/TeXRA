import { css } from 'lit';

/** The same widget typography and geometry for the editor and diff viewer. */
export const monacoStyles = css`
  /* Context menus may be portaled outside the editor's shadow/slot tree.
     Give those portals the same host palette as the editor theme adapter. */
  :root,
  :host,
  .monaco-component {
    --vscode-menu-background: var(--wa-color-menu-background);
    --vscode-menu-foreground: var(--wa-color-text-normal);
    --vscode-menu-border: var(--wa-color-surface-border);
    --vscode-menu-selectionBackground: var(--wa-color-brand-fill-quiet);
    --vscode-menu-selectionForeground: var(--wa-color-text-normal);
    --vscode-menu-separatorBackground: var(--wa-color-surface-border);
    --vscode-widget-shadow: var(--wa-color-surface-shadow);
    --vscode-editorHoverWidget-background: var(--wa-color-menu-background);
    --vscode-editorHoverWidget-foreground: var(--wa-color-text-normal);
    --vscode-editorHoverWidget-border: var(--wa-color-surface-border);
  }

  .monaco-menu-container .monaco-menu {
    background: var(--wa-color-menu-background);
    color: var(--wa-color-text-normal);
    border: var(--border-thin) solid var(--wa-color-surface-border);
    border-radius: var(--panel-radius);
  }

  /* Menu entries already expose their full names. Their duplicate hover
     labels can escape the menu and be clipped by the editor pane. */
  :root:has(.monaco-menu-container .monaco-menu) .workbench-hover {
    display: none;
  }

  .monaco-editor .margin-view-overlays .line-numbers {
    font-family: var(--wa-font-family-body);
    font-size: var(--font-size-xs);
    font-variant-numeric: tabular-nums;
  }

  .monaco-editor .line-numbers.active-line-number {
    font-weight: var(--font-weight-medium);
  }

  .quick-input-widget,
  .monaco-editor .suggest-widget,
  .monaco-hover,
  .monaco-menu-container {
    font-family: var(--wa-font-family-body);
    font-size: var(--font-size-sm);
    border-radius: var(--panel-radius);
  }

  .quick-input-widget {
    border: var(--border-thin) solid var(--wa-color-surface-border);
    box-shadow: 0 8px 24px var(--wa-color-surface-shadow);
    max-width: calc(100vw - 24px);
  }

  .monaco-hover {
    max-width: min(400px, calc(100vw - 24px));
    overflow-wrap: anywhere;
  }

  /* Override Monaco's inline coordinates only for command descriptions.
     Native popover placement escapes pane clipping and flips at window edges. */
  .texra-command-tooltip {
    position: fixed !important;
    inset: auto !important;
    position-area: inline-start;
    position-try-fallbacks:
      flip-inline, --texra-tooltip-below, --texra-tooltip-above;
    width: max-content;
    max-width: min(360px, calc(100vw - 24px));
    margin: 0 8px;
    padding: 0;
    border: 0;
    overflow: visible;
    background: transparent;
    color: var(--wa-color-text-normal);
  }

  .texra-command-tooltip .workbench-hover {
    max-width: min(360px, calc(100vw - 24px)) !important;
    border-radius: var(--field-radius);
    font-family: var(--wa-font-family-body);
    font-size: var(--font-size-sm);
  }

  .texra-command-tooltip .workbench-hover-pointer {
    display: none;
  }

  @position-try --texra-tooltip-below {
    position-area: block-end;
    margin: 8px 0;
  }

  @position-try --texra-tooltip-above {
    position-area: block-start;
    margin: 8px 0;
  }

  .monaco-resizable-hover,
  .monaco-editor .monaco-hover {
    border-radius: var(--wa-tooltip-border-radius, var(--field-radius));
  }

  .quick-input-widget .quick-input-header {
    padding: var(--wa-space-xs);
  }

  .quick-input-widget .monaco-inputbox {
    border-radius: var(--field-radius);
  }

  .quick-input-widget .monaco-inputbox > .ibwrapper > .input {
    font: inherit;
    min-height: var(--height-control-compact);
  }

  .quick-input-widget .monaco-inputbox.synthetic-focus {
    outline-width: var(--border-thin);
    outline-offset: 0;
  }

  .quick-input-widget .monaco-keybinding-key {
    font-family: var(--wa-font-family-body);
    font-size: var(--font-size-xs);
    border-radius: var(--border-radius-small);
    box-shadow: none;
  }

  .monaco-editor .find-widget {
    border-radius: var(--field-radius);
    font-family: var(--wa-font-family-body);
  }
`;
