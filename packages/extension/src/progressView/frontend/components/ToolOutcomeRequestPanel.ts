/** Tool outcome card: a call that may have run with no recorded result,
 *  Run again / Skip. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Local imports - shared
import type { TeXRAIconName } from '@ui/wa/iconNames';

// Local imports - base class
import { BaseRequestPanel } from './BaseRequestPanel';

@customElement('tool-outcome-request-panel')
export class ToolOutcomeRequestPanel extends BaseRequestPanel<'toolOutcome'> {
  protected override get primaryIcon(): TeXRAIconName {
    return 'rotate-right';
  }

  protected override get primaryLabel(): string {
    return 'Run again';
  }

  protected override get decline(): 'skip' {
    return 'skip';
  }

  protected override get declineTakesNote(): boolean {
    return false;
  }

  protected override submitPrimary(): void {
    this.emitAction({ action: 'retry' });
  }

  protected override renderAsk(): string {
    return `${this.permission.data.toolName} may have run before the run was interrupted`;
  }

  override render(): TemplateResult {
    const { title, childRunId } = this.permission.data;
    return this.renderCard(html`
      <div dir="auto">${title}</div>
      ${
        childRunId === null
          ? nothing
          : html`<div>Run <code>${childRunId}</code></div>`
      }
    `);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tool-outcome-request-panel': ToolOutcomeRequestPanel;
  }
}
