// Third-party imports
import { LitElement, css, html, unsafeCSS } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import xtermStyles from '@xterm/xterm/css/xterm.css?inline';

const DEFAULT_THEME = {
  background: '#1e1e1e',
  foreground: '#cccccc',
  fontFamily: 'monospace',
} as const;

const MIN_SCROLLBACK = 4_000;

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
        min-height: 64px;
        max-height: var(--height-large);
        overflow: auto;
      }
    `,
  ];

  @property({ type: String }) text = '';

  @query('.terminal-container')
  private terminalContainer!: HTMLDivElement;

  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private detailsElement: HTMLDetailsElement | null = null;
  private isFlushingText = false;
  private needsFlush = false;
  private pendingText = '';

  private readonly handleDetailsToggle = (): void => {
    this.refitIfVisible();
  };

  private readonly handleWindowResize = (): void => {
    this.refitIfVisible();
  };

  override firstUpdated(): void {
    const resolvedTheme = this.resolveThemeFromCssVars();
    this.terminal = new Terminal({
      disableStdin: true,
      convertEol: true,
      scrollback: MIN_SCROLLBACK,
      fontFamily: resolvedTheme.fontFamily,
      fontSize: 12,
      theme: {
        background: resolvedTheme.background,
        foreground: resolvedTheme.foreground,
      },
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

    this.detailsElement?.removeEventListener(
      'toggle',
      this.handleDetailsToggle,
    );
    this.detailsElement = null;
    window.removeEventListener('resize', this.handleWindowResize);

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
  }

  private attachResizeHooks(): void {
    this.detailsElement = this.closest('details');
    this.detailsElement?.addEventListener('toggle', this.handleDetailsToggle);
    window.addEventListener('resize', this.handleWindowResize);

    this.resizeObserver = new ResizeObserver(() => {
      this.refitIfVisible();
    });
    this.resizeObserver.observe(this);
  }

  private refitIfVisible(): void {
    if (!this.terminal || !this.fitAddon) return;
    if (this.offsetParent === null) return;

    const { width, height } = this.getBoundingClientRect();
    if (width === 0 || height === 0) return;

    this.fitAddon.fit();
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

        const text = this.pendingText;
        const lineCount = text.split('\n').length;
        const scrollback = Math.max(MIN_SCROLLBACK, lineCount);
        if (this.terminal.options.scrollback !== scrollback) {
          this.terminal.options = {
            ...this.terminal.options,
            scrollback,
          };
        }

        this.terminal.reset();
        await new Promise<void>((resolve) => {
          this.terminal?.write(text, () => resolve());
        });
        this.refitIfVisible();
      }
    } finally {
      this.isFlushingText = false;
      if (this.needsFlush) {
        this.renderTerminalText();
      }
    }
  }

  private resolveThemeFromCssVars(): {
    background: string;
    foreground: string;
    fontFamily: string;
  } {
    const styles = getComputedStyle(this);

    const background =
      styles.getPropertyValue('--vscode-editor-background').trim() ||
      DEFAULT_THEME.background;
    const foreground =
      styles.getPropertyValue('--vscode-editor-foreground').trim() ||
      DEFAULT_THEME.foreground;
    const fontFamily =
      styles.getPropertyValue('--vscode-editor-font-family').trim() ||
      DEFAULT_THEME.fontFamily;

    return { background, foreground, fontFamily };
  }

  override render() {
    return html`<div class="terminal-container"></div>`;
  }
}
