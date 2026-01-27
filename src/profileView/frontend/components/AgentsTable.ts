/**
 * AgentsTable component - displays table of available remote agents with selection buttons.
 */

// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import { badgeStyles, codiconStyles, designTokens } from '@shared/styles';

// Local imports - profile view styles
import { profileViewStyles } from '../styles';

// Local imports - profile view events
import { ProfileViewEvents } from '../events';

// Local imports - shared schemas
import type { RemoteAgent } from '@shared/schemas';

@customElement('agents-table')
export class AgentsTable extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    ...badgeStyles,
    profileViewStyles,
  ];

  @property({ attribute: false }) agents: RemoteAgent[] = [];

  private handleSelect(event: Event): void {
    const target = event.currentTarget as HTMLElement | null;
    const agentName = target?.dataset.agent;
    if (!agentName) return;
    this.dispatchEvent(ProfileViewEvents.selectAgent({ agentName }));
  }

  private normalizeVisibility(visibility: string | string[]): string[] {
    return Array.isArray(visibility) ? visibility : [visibility];
  }

  private renderAgentRow(agent: RemoteAgent): TemplateResult {
    const visibilityArray = this.normalizeVisibility(agent.visibility);
    const visibilityClass =
      visibilityArray[0] === 'public' ? 'public' : 'custom';
    const multiOutputClass = agent.supportsMultipleOutput
      ? 'supported'
      : 'not-supported';
    const multiOutputIcon = agent.supportsMultipleOutput
      ? 'codicon-check'
      : 'codicon-close';
    // Normalize category for CSS class (e.g., "toolUse" -> "tooluse")
    const categoryClass = (agent.category || '').toLowerCase().replace('-', '');

    return html`
      <tr class="agent-row">
        <td class="agent-name">${agent.name}</td>
        <td class="agent-category">
          <span class="badge badge--small category-badge ${categoryClass}"
            >${agent.category}</span
          >
        </td>
        <td class="agent-multi-output">
          <span
            class="badge badge--small multi-output-badge ${multiOutputClass}"
            aria-label=${agent.supportsMultipleOutput
              ? 'Supports multiple outputs'
              : 'Single output only'}
          >
            <span class="codicon ${multiOutputIcon}"></span>
          </span>
        </td>
        <td class="agent-description">${agent.description}</td>
        <td class="agent-visibility">
          <span class="badge badge--small visibility-badge ${visibilityClass}">
            ${visibilityArray.join(', ')}
          </span>
        </td>
        <td class="agent-action">
          <vscode-button
            class="select-btn"
            appearance="primary"
            data-agent=${agent.name}
            @click=${this.handleSelect}
          >
            <span slot="start" class="codicon codicon-arrow-right"></span>
            Select
          </vscode-button>
        </td>
      </tr>
    `;
  }

  override render(): TemplateResult {
    return html`
      <table class="agents-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Category</th>
            <th>Multi-Output</th>
            <th>Description</th>
            <th>Visibility</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${repeat(
            this.agents,
            (agent) => agent.name,
            (agent) => this.renderAgentRow(agent),
          )}
        </tbody>
      </table>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'agents-table': AgentsTable;
  }
}
