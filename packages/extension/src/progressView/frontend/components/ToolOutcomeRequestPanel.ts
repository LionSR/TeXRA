/** Tool outcome card: "Did X finish before TeXRA stopped?", for a call that
 *  may have run with no recorded result. Run again / Skip it. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';

// Local imports - shared
import { SessionUiEvents } from '@shared/session/uiEvents';
import { TOOL_OUTCOME_COPY } from '@ui/copy/toolOutcome';
import type { TeXRAIconName } from '@ui/wa/iconNames';

// Local imports - base class
import { BaseRequestPanel } from './BaseRequestPanel';

@customElement('tool-outcome-request-panel')
export class ToolOutcomeRequestPanel extends BaseRequestPanel<'toolOutcome'> {
  protected override get primaryIcon(): TeXRAIconName {
    return 'rotate-right';
  }

  protected override get primaryLabel(): string {
    return TOOL_OUTCOME_COPY.runAgain;
  }

  protected override get decline(): 'skip' {
    return 'skip';
  }

  protected override get declineLabel(): string {
    return TOOL_OUTCOME_COPY.skip;
  }

  protected override get declineTakesNote(): boolean {
    return false;
  }

  protected override submitPrimary(): void {
    this.emitAction({ action: 'retry' });
  }

  protected override renderAsk(): string {
    return TOOL_OUTCOME_COPY.question(this.permission.data);
  }

  override render(): TemplateResult {
    const { title, childRunId } = this.permission.data;
    return this.renderCard(html`
      <div dir="auto">${title}</div>
      <div>${TOOL_OUTCOME_COPY.explanation}</div>
      ${
        childRunId === null
          ? nothing
          : html`<a
              href="#"
              @click=${(event: Event) => {
                event.preventDefault();
                this.dispatchEvent(
                  SessionUiEvents.surface({
                    kind: 'select',
                    runId: childRunId,
                  }),
                );
              }}
              >Open the agent's conversation</a
            >`
      }
    `);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tool-outcome-request-panel': ToolOutcomeRequestPanel;
  }
}
