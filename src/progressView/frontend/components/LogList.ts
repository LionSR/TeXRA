// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { guard } from 'lit/directives/guard.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

// Local imports - formatters
import { formatLogEntry } from '../formatters/logFormatter';

// Local types
import type { LogMessageData } from '@shared/schemas';

const EMPTY_PLACEHOLDER_HTML =
  'No runs yet—use TeXRA commands to start. Try ' +
  '<a href="command:texra.openGettingStarted">open the getting started walkthrough</a>, ' +
  '<a href="command:texra.createSampleProject">create a sample project</a>, ' +
  '<a href="command:texra.cloneOverleafProject">clone an Overleaf project</a>, or ' +
  '<a href="command:texra.downloadArXivSource">download an arXiv source</a>.';

@customElement('log-list')
export class LogList extends LitElement {
  @property({ type: Array }) logs: LogMessageData[] = [];

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  private renderLogEntry(log: LogMessageData) {
    return guard(
      [log.id, log.text, log.timestamp, log.messageType, log.level],
      () => formatLogEntry(log),
    );
  }

  override render() {
    if (this.logs.length === 0) {
      return html`
        <div class="log-container" id="logContent">
          <div class="log-placeholder" id="logPlaceholder">
            ${unsafeHTML(EMPTY_PLACEHOLDER_HTML)}
          </div>
        </div>
      `;
    }

    return html`
      <div class="log-container" id="logContent">
        ${repeat(
          this.logs,
          (log) => log.id ?? `${log.timestamp}-${log.text}`,
          (log) => this.renderLogEntry(log),
        )}
      </div>
    `;
  }
}
