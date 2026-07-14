// Third-party imports
import { LitElement, css, html, unsafeCSS } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import xtermStyles from '@xterm/xterm/css/xterm.css?inline';
import { clamp } from '@utils/core';

const DEFAULT_THEME = {
  background: '#1e1e1e',
  foreground: '#cccccc',
  fontFamily: 'monospace',
} as const;

/** VS Code terminal ANSI color CSS variables mapped to xterm.js theme keys. */
const ANSI_COLOR_MAP = [
  ['black', '--texra-terminal-ansiBlack'],
  ['red', '--texra-terminal-ansiRed'],
  ['green', '--texra-terminal-ansiGreen'],
  ['yellow', '--texra-terminal-ansiYellow'],
  ['blue', '--texra-terminal-ansiBlue'],
  ['magenta', '--texra-terminal-ansiMagenta'],
  ['cyan', '--texra-terminal-ansiCyan'],
  ['white', '--texra-terminal-ansiWhite'],
  ['brightBlack', '--texra-terminal-ansiBrightBlack'],
  ['brightRed', '--texra-terminal-ansiBrightRed'],
  ['brightGreen', '--texra-terminal-ansiBrightGreen'],
  ['brightYellow', '--texra-terminal-ansiBrightYellow'],
  ['brightBlue', '--texra-terminal-ansiBrightBlue'],
  ['brightMagenta', '--texra-terminal-ansiBrightMagenta'],
  ['brightCyan', '--texra-terminal-ansiBrightCyan'],
  ['brightWhite', '--texra-terminal-ansiBrightWhite'],
] as const;

const MIN_SCROLLBACK = 4_000;

/** Maximum visible rows before terminal scrolls internally. */
const MAX_VISIBLE_ROWS = 20;

/**
 * Events that signal an ancestor disclosure container revealed this terminal,
 * so it should refit to its now-visible container. Covers both the legacy
 * native `<details>` `toggle` event (still emitted by any un-migrated
 * surface) and Web Awesome's `<wa-details>`, which is not a `<details>` and
 * never fires `toggle` — it dispatches `wa-show` synchronously when it starts
 * opening and `wa-after-show` once its reveal animation finishes. Listening
 * to both wa-details events covers the immediate-open case (matching the old
 * un-animated native-toggle timing) and the post-animation case (accurate
 * final layout for the fit-addon column/row calculation).
 */
const TERMINAL_REFIT_EVENTS = [
  'toggle',
  'wa-show',
  'wa-after-show',
] as const;

/** Ancestor selector for the ancestor disclosure container, matching both
 * the Web Awesome `<wa-details>` custom element and any un-migrated native
 * `<details>` surface. */
const DETAILS_ANCESTOR_SELECTOR = 'wa-details, details';

export interface TerminalTextUpdatePlan {
  reset: boolean;
  textToWrite: string;
}

export function planTerminalTextUpdate(
  renderedText: string,
  nextText: string,
): TerminalTextUpdatePlan {
  if (nextText.startsWith(renderedText)) {
    return {
      reset: false,
      textToWrite: nextText.slice(renderedText.length),
    };
  }

  return {
    reset: true,
    textToWrite: nextText,
  };
}

export function countTerminalRows(text: string): number {
  let rows = 1;
  for (const char of text) {
    if (char === '\n') rows += 1;
  }
  return rows;
}

export function nextTerminalRowCount(
  previousRowCount: number,
  updatePlan: TerminalTextUpdatePlan,
): number {
  return updatePlan.reset
    ? countTerminalRows(updatePlan.textToWrite)
    : previousRowCount + countTerminalRows(updatePlan.textToWrite) - 1;
}

/**
 * Read-only terminal renderer for shell output.
 * Uses xterm.js for ANSI colors/formatting without interactive input.
 */
@customElement('terminal-output')
export class TerminalOutput extends LitElement {
  static override styles = [
    css`
      ${unsafeCSS(xtermStyles)}

      :host {
        display: block;
      }

      .terminal-container {
        overflow: hidden;
      }
    `,
  ];

  @property({ type: String }) text = '';

  @query('.terminal-container')
  private terminalContainer!: HTMLDivElement;

  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private detailsElement: Element | null = null;
  private isFlushingText = false;
  private needsFlush = false;
  private pendingText = '';
  private renderedText = '';
  private renderedRowCount = countTerminalRows('');

  private readonly handleDetailsToggle = (): void => {
    this.refitIfVisible();
  };

  private readonly handleWindowResize = (): void => {
    this.refitIfVisible();
  };

  override firstUpdated(): void {
    const { theme, fontFamily } = this.resolveTerminalOptions();
    this.terminal = new Terminal({
      disableStdin: true,
      convertEol: true,
      scrollback: MIN_SCROLLBACK,
      fontFamily,
      fontSize: 12,
      theme,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.terminalContainer);

    this.attachResizeHooks();
    this.refitIfVisible();
  }

  override updated(changedProperties: Map<string, unknown>): void {
    if (!changedProperties.has('text')) return;
    this.pendingText = this.text;
    this.needsFlush = true;
    this.renderTerminalText();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();

    for (const eventName of TERMINAL_REFIT_EVENTS) {
      this.detailsElement?.removeEventListener(
        eventName,
        this.handleDetailsToggle,
      );
    }
    this.detailsElement = null;
    window.removeEventListener('resize', this.handleWindowResize);

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
  }

  private attachResizeHooks(): void {
    this.detailsElement = this.closest(DETAILS_ANCESTOR_SELECTOR);
    for (const eventName of TERMINAL_REFIT_EVENTS) {
      this.detailsElement?.addEventListener(
        eventName,
        this.handleDetailsToggle,
      );
    }
    window.addEventListener('resize', this.handleWindowResize);

    this.resizeObserver = new ResizeObserver(() => {
      this.refitIfVisible();
    });
    this.resizeObserver.observe(this);
  }

  private refitIfVisible(): void {
    if (!this.terminal || !this.fitAddon) return;
    if (this.offsetParent === null) return;

    const { width } = this.getBoundingClientRect();
    if (width === 0) return;

    // Get optimal column count from FitAddon (based on container width)
    const dims = this.fitAddon.proposeDimensions();
    const cols = dims?.cols ?? this.terminal.cols;

    // Size rows to content instead of filling the container
    const buffer = this.terminal.buffer.active;
    const contentRows = buffer.baseY + buffer.cursorY + 1;
    const rows = clamp(contentRows, 1, MAX_VISIBLE_ROWS);

    if (cols !== this.terminal.cols || rows !== this.terminal.rows) {
      this.terminal.resize(cols, rows);
    }
  }

  private renderTerminalText(): void {
    if (this.isFlushingText) return;

    this.isFlushingText = true;
    void this.flushTerminalText();
  }

  private async flushTerminalText(): Promise<void> {
    try {
      while (this.needsFlush) {
        this.needsFlush = false;
        if (!this.terminal) continue;
        const terminal = this.terminal;

        const text = this.pendingText;
        const activeBuffer = terminal.buffer.active;
        const previousBaseY = activeBuffer.baseY;
        const previousViewportY = activeBuffer.viewportY;
        const distanceFromBottom = previousBaseY - previousViewportY;
        const wasPinnedToBottom = distanceFromBottom <= 1;

        const updatePlan = planTerminalTextUpdate(this.renderedText, text);
        const rowCount = nextTerminalRowCount(
          this.renderedRowCount,
          updatePlan,
        );
        const scrollback = Math.max(MIN_SCROLLBACK, rowCount);
        if (terminal.options.scrollback !== scrollback) {
          terminal.options = {
            ...terminal.options,
            scrollback,
          };
        }

        if (updatePlan.reset) {
          terminal.reset();
        }
        await this.writeTerminalText(terminal, updatePlan.textToWrite);

        if (!this.terminal || this.terminal !== terminal) continue;

        this.renderedText = text;
        this.renderedRowCount = rowCount;
        if (!wasPinnedToBottom) {
          const nextBaseY = terminal.buffer.active.baseY;
          const targetViewportY = Math.max(0, nextBaseY - distanceFromBottom);
          terminal.scrollToLine(targetViewportY);
        }

        this.refitIfVisible();
      }
    } finally {
      this.isFlushingText = false;
      if (this.needsFlush) {
        this.renderTerminalText();
      }
    }
  }

  private async writeTerminalText(
    terminal: Terminal,
    text: string,
  ): Promise<void> {
    if (!text) return;

    await new Promise<void>((resolve) => {
      let resolved = false;
      const complete = (): void => {
        if (resolved) return;
        resolved = true;
        resolve();
      };

      terminal.write(text, complete);
      setTimeout(complete, 100);
    });
  }

  /** Resolve theme colors and font family from VS Code CSS variables in a single getComputedStyle call. */
  private resolveTerminalOptions(): {
    theme: Record<string, string>;
    fontFamily: string;
  } {
    const styles = getComputedStyle(this);

    const theme: Record<string, string> = {
      background:
        styles.getPropertyValue('--wa-color-surface-default').trim() ||
        DEFAULT_THEME.background,
      foreground:
        styles.getPropertyValue('--wa-color-text-normal').trim() ||
        DEFAULT_THEME.foreground,
    };

    for (const [key, cssVar] of ANSI_COLOR_MAP) {
      const value = styles.getPropertyValue(cssVar).trim();
      if (value) theme[key] = value;
    }

    const cursor = styles
      .getPropertyValue('--texra-terminalCursor-foreground')
      .trim();
    if (cursor) theme['cursor'] = cursor;

    const selectionBg = styles
      .getPropertyValue('--texra-terminal-selectionBackground')
      .trim();
    if (selectionBg) theme['selectionBackground'] = selectionBg;

    const fontFamily =
      styles.getPropertyValue('--texra-editor-font-family').trim() ||
      DEFAULT_THEME.fontFamily;

    return { theme, fontFamily };
  }

  override render() {
    return html`<div class="terminal-container"></div>`;
  }
}
