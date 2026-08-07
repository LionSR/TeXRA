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

/** Web Awesome terminal ANSI color tokens mapped to xterm.js theme keys. */
const ANSI_COLOR_MAP = [
  ['black', '--wa-color-terminal-ansi-black'],
  ['red', '--wa-color-terminal-ansi-red'],
  ['green', '--wa-color-terminal-ansi-green'],
  ['yellow', '--wa-color-terminal-ansi-yellow'],
  ['blue', '--wa-color-terminal-ansi-blue'],
  ['magenta', '--wa-color-terminal-ansi-magenta'],
  ['cyan', '--wa-color-terminal-ansi-cyan'],
  ['white', '--wa-color-terminal-ansi-white'],
  ['brightBlack', '--wa-color-terminal-ansi-bright-black'],
  ['brightRed', '--wa-color-terminal-ansi-bright-red'],
  ['brightGreen', '--wa-color-terminal-ansi-bright-green'],
  ['brightYellow', '--wa-color-terminal-ansi-bright-yellow'],
  ['brightBlue', '--wa-color-terminal-ansi-bright-blue'],
  ['brightMagenta', '--wa-color-terminal-ansi-bright-magenta'],
  ['brightCyan', '--wa-color-terminal-ansi-bright-cyan'],
  ['brightWhite', '--wa-color-terminal-ansi-bright-white'],
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
const TERMINAL_REFIT_EVENTS = ['toggle', 'wa-show', 'wa-after-show'] as const;

/** Ancestor selector for the ancestor disclosure container, matching both
 * the Web Awesome `<wa-details>` custom element and any un-migrated native
 * `<details>` surface. */
const DETAILS_ANCESTOR_SELECTOR = 'wa-details, details';

interface TerminalTextUpdatePlan {
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

    // Whichever lands first wins; a promise ignores every later resolve.
    await new Promise<void>((resolve) => {
      terminal.write(text, () => resolve());
      setTimeout(() => resolve(), 100);
    });
  }

  /** Resolve theme colors and font family from `--wa-*` tokens in a single getComputedStyle call. */
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

    const cursor = styles.getPropertyValue('--wa-color-terminal-cursor').trim();
    if (cursor) theme['cursor'] = cursor;

    const selectionBg = styles
      .getPropertyValue('--wa-color-terminal-selection-bg')
      .trim();
    if (selectionBg) theme['selectionBackground'] = selectionBg;

    const fontFamily =
      styles.getPropertyValue('--wa-font-family-mono').trim() ||
      DEFAULT_THEME.fontFamily;

    return { theme, fontFamily };
  }

  override render() {
    return html`<div class="terminal-container"></div>`;
  }
}
