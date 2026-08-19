// Third-party imports
import { LitElement, css, html, unsafeCSS } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import xtermStyles from '@xterm/xterm/css/xterm.css?inline';

import { resolveXtermTheme } from '@shared/wa/xtermTheme';
import { clamp } from '@utils/core';

const MIN_SCROLLBACK = 4_000;

/** Maximum visible rows before terminal scrolls internally. */
const MAX_VISIBLE_ROWS = 20;

/**
 * Events that signal the ancestor `<wa-details>` disclosure revealed this
 * terminal, so it should refit to its now-visible container. `wa-show` fires
 * synchronously when the disclosure starts opening (immediate-open case) and
 * `wa-after-show` once its reveal animation finishes (accurate final layout
 * for the fit-addon column/row calculation).
 */
const TERMINAL_REFIT_EVENTS = ['wa-show', 'wa-after-show'] as const;

/** Ancestor selector for the `<wa-details>` disclosure container. */
const DETAILS_ANCESTOR_SELECTOR = 'wa-details';

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

      :host([fill]),
      :host([fill]) .terminal-container {
        height: 100%;
      }
    `,
  ];

  @property({ type: String }) text = '';

  /**
   * Fill the host box instead of sizing rows to the content.
   *
   * Tool cards embed a terminal inside a growing disclosure, so there the row
   * count follows the content up to {@link MAX_VISIBLE_ROWS}. A stream pane
   * gives the terminal a fixed-height box and expects it to fill it and scroll
   * internally, which is what this selects.
   */
  @property({ type: Boolean, reflect: true }) fill = false;

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
    const { theme, fontFamily } = resolveXtermTheme(this);
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

  /**
   * Re-measure against the current container box. Public because a host that
   * keeps this element in the DOM while hidden (the stream-pane cache) has to
   * say when it became visible — `offsetParent` is null until then, so every
   * fit attempted while hidden is skipped.
   */
  refitIfVisible(): void {
    if (!this.terminal || !this.fitAddon) return;
    if (this.offsetParent === null) return;

    const { width } = this.getBoundingClientRect();
    if (width === 0) return;

    // Get optimal column and row count from FitAddon (based on container box)
    const dims = this.fitAddon.proposeDimensions();
    const cols = dims?.cols ?? this.terminal.cols;

    // Size rows to content instead of filling the container, unless the host
    // asked for a fill.
    const buffer = this.terminal.buffer.active;
    const contentRows = buffer.baseY + buffer.cursorY + 1;
    const rows = this.fill
      ? (dims?.rows ?? this.terminal.rows)
      : clamp(contentRows, 1, MAX_VISIBLE_ROWS);

    if (cols !== this.terminal.cols || rows !== this.terminal.rows) {
      this.terminal.resize(cols, rows);
    }
  }

  /** Pin the viewport to the newest output. */
  scrollToBottom(): void {
    this.terminal?.scrollToBottom();
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

  override render() {
    return html`<div class="terminal-container"></div>`;
  }
}
