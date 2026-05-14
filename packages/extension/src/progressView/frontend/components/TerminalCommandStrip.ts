/** Renders a `$ <command>` strip above process-agent stream output. */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('terminal-command-strip')
export class TerminalCommandStrip extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }

    .strip {
      display: flex;
      align-items: baseline;
      gap: var(--wa-space-2xs);
      padding: var(--wa-space-2xs) var(--wa-space-s);
      margin: 0 0 var(--wa-space-2xs) 0;
      background: var(
        --wa-color-terminal-background,
        var(--wa-color-surface-default, transparent)
      );
      color: var(--wa-color-terminal-foreground, var(--wa-color-text-normal));
      border: var(--border-thin) solid
        var(--wa-color-surface-border, transparent);
      border-radius: var(--border-radius-small);
      font-family: var(
        --wa-font-family-mono,
        ui-monospace,
        SFMono-Regular,
        Consolas,
        monospace
      );
      font-size: var(--wa-editor-font-size, var(--font-size-sm));
      max-height: min(32vh, 320px);
      overflow-y: auto;
      overflow-x: hidden;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .strip > span {
      min-width: 0;
    }

    .prompt {
      color: var(--wa-color-terminal-ansi-green, var(--color-success, #0a0));
      font-weight: var(--font-weight-semibold);
      user-select: none;
      flex: 0 0 auto;
    }

    .command {
      flex: 1 1 auto;
    }
  `;

  @property({ type: String }) command = '';

  override render(): TemplateResult | typeof nothing {
    const trimmed = this.command.trim();
    if (!trimmed) return nothing;
    return html`
      <div class="strip">
        <span class="prompt">$</span>
        <span class="command">${trimmed}</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'terminal-command-strip': TerminalCommandStrip;
  }
}
