// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import { designTokens, codiconStyles } from '@shared/styles';

// Local imports - profile view styles
import { profileViewStyles } from '../styles';

// Local imports - profile view events
import { ProfileViewEvents } from '../events';

// Local imports - shared schemas
import type { RemoteAgent } from '@shared/schemas';

@customElement('agents-table')
export class AgentsTable extends LitElement {
  static styles = [designTokens, codiconStyles, profileViewStyles];

  @property({ attribute: false }) agents: RemoteAgent[] = [];

  private handleSelect = (agentName: string): void => {
    this.dispatchEvent(ProfileViewEvents.selectAgent({ agentName }));
  };

  private renderAgentRow(agent: RemoteAgent): TemplateResult {
    const visibilityArray = Array.isArray(agent.visibility)
      ? agent.visibility
      : [agent.visibility];
    const firstVisibility = visibilityArray[0] || 'public';
    const visibilityClass = firstVisibility === 'public' ? 'public' : 'custom';
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
            @click=${() => this.handleSelect(agent.name)}
          >
            <span slot="start" class="codicon codicon-arrow-right"></span>
            Select
          </vscode-button>
        </td>
      </tr>
    `;
  }

  render(): TemplateResult {
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
