/** Renders a `$ <command>` strip in VS Code terminal styling. Used above
 * process-agent stream output to show the command that spawned the session. */

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
      gap: var(--wa-space-2xs, 8px);
      padding: 6px 10px;
      margin: 0 0 8px 0;
      background: var(
        --texra-terminal-background,
        var(--texra-editor-background, transparent)
      );
      color: var(--texra-terminal-foreground, var(--wa-color-text-normal));
      border: 1px solid var(--texra-panel-border, transparent);
      border-radius: 3px;
      font-family: var(
        --texra-editor-font-family,
        ui-monospace,
        SFMono-Regular,
        Consolas,
        monospace
      );
      font-size: var(--texra-editor-font-size, 12px);
      max-height: min(32vh, 320px);
      overflow: auto;
      white-space: pre;
    }

    /* flex-shrink: 0 keeps the command at its intrinsic width so the strip
       can actually scroll horizontally for long commands. */
    .strip > span {
      flex-shrink: 0;
    }

    .prompt {
      color: var(--texra-terminal-ansiGreen, var(--color-success, #0a0));
      font-weight: 600;
      user-select: none;
    }
  `;

  @property({ type: String }) command = '';

  override render(): TemplateResult | typeof nothing {
    const trimmed = this.command.trim();
    if (!trimmed) return nothing;
    return html`
      <div class="strip">
        <span class="prompt">$</span>
        <span>${trimmed}</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'terminal-command-strip': TerminalCommandStrip;
  }
}
