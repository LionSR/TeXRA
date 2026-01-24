// Third-party imports
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { consume } from '@lit/context';

// Local imports - common commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - shared schemas
import type { StreamTabInfo } from '@shared/schemas';

// Local imports - progress view context
import { commandsContext, type CommandsContextValue } from '../../context';

/**
 * Renders a single stream tab.
 */
@customElement('stream-tab')
export class StreamTab extends LitElement {
  @property({ type: Object })
  stream!: StreamTabInfo;

  @property({ type: Boolean })
  active = false;

  @consume({ context: commandsContext })
  private commands!: CommandsContextValue;

  protected createRenderRoot() {
    return this;
  }

  private handleClick(): void {
    this.commands.postCommand(PROGRESS_VIEW_COMMANDS.SWITCH_STREAM, {
      stream: this.stream.name,
    });
  }

  private handleDelete(event: Event): void {
    event.stopPropagation();
    this.commands.postCommand(PROGRESS_VIEW_COMMANDS.DELETE_STREAM, {
      stream: this.stream.name,
    });
  }

  render() {
    return html`
      <button
        class=${classMap({ 'stream-tab': true, active: this.active })}
        @click=${this.handleClick}
      >
        <span>${this.stream.label}</span>
        ${this.stream.status
          ? html`<small>${this.stream.status}</small>`
          : null}
      </button>
      <button class="ghost" title="Delete stream" @click=${this.handleDelete}>
        Remove
      </button>
    `;
  }
}
