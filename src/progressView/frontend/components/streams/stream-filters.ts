// Third-party imports
import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { consume } from '@lit/context';

// Local imports - shared schemas
import { AgentCategory } from '@shared/schemas';

// Local imports - common commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view context
import {
  commandsContext,
  streamContext,
  type CommandsContextValue,
  type StreamContextValue,
} from '../../context';

/**
 * Renders stream filter and sort controls.
 */
@customElement('stream-filters')
export class StreamFilters extends LitElement {
  @consume({ context: commandsContext })
  private commands!: CommandsContextValue;

  @consume({ context: streamContext })
  private streamData?: StreamContextValue;

  protected createRenderRoot() {
    return this;
  }

  private handleFilterChange(filter: string): void {
    this.commands.postCommand(PROGRESS_VIEW_COMMANDS.FILTER_STREAMS, {
      filter,
    });
  }

  private handleSortChange(sortBy: 'time' | 'inputFile' | 'agent'): void {
    this.commands.postCommand(PROGRESS_VIEW_COMMANDS.SORT_STREAMS, { sortBy });
  }

  render() {
    const filter = this.streamData?.streamFilter ?? 'all';

    return html`
      <div class="toolbar">
        <button
          class=${classMap({ secondary: filter === 'all' })}
          @click=${() => this.handleFilterChange('all')}
        >
          All
        </button>
        <button
          class=${classMap({ secondary: filter === 'workflow' })}
          @click=${() => this.handleFilterChange(AgentCategory.Workflow)}
        >
          Workflow
        </button>
        <button
          class=${classMap({ secondary: filter === 'toolUse' })}
          @click=${() => this.handleFilterChange(AgentCategory.ToolUse)}
        >
          Tool Use
        </button>
        <button class="ghost" @click=${() => this.handleSortChange('time')}>
          Sort: Time
        </button>
        <button class="ghost" @click=${() => this.handleSortChange('agent')}>
          Sort: Agent
        </button>
        <button
          class="ghost"
          @click=${() => this.handleSortChange('inputFile')}
        >
          Sort: Input
        </button>
      </div>
    `;
  }
}
