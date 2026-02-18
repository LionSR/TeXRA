// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

// Third-party imports - styles
import '@xterm/xterm/css/xterm.css';

@customElement('terminal-output')
export class TerminalOutput extends LitElement {
  @property({ type: String }) text = '';

  @query('.terminal-container')
  private terminalContainer!: HTMLDivElement;

  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;

  protected override createRenderRoot(): this {
    return this;
  }

  override firstUpdated(): void {
    this.terminal = new Terminal({
      disableStdin: true,
      convertEol: true,
      scrollback: 4_000,
      fontFamily: 'var(--vscode-editor-font-family, monospace)',
      fontSize: 12,
      theme: {
        background: 'var(--vscode-editor-background, #1e1e1e)',
        foreground: 'var(--vscode-editor-foreground, #cccccc)',
      },
    });
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.terminalContainer);
    this.fitAddon.fit();
    this.renderTerminalText();
  }

  override updated(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has('text')) {
      this.renderTerminalText();
      this.fitAddon?.fit();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
  }

  private renderTerminalText(): void {
    if (!this.terminal) return;
    this.terminal.reset();
    this.terminal.write(this.text);
  }

  override render() {
    return html`<div class="terminal-container"></div>`;
  }
}
