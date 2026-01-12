/**
 * Agent List Renderer
 */
import { AGENT_TYPE_ICONS } from '../constants.js';

/**
 * Render agent type badge
 */
export function renderAgentTypeBadge(agentType) {
  const typeInfo = AGENT_TYPE_ICONS[agentType] || AGENT_TYPE_ICONS.CoT;
  return `
    <span class="agent-type-badge" title="${typeInfo.title}">
      <span class="codicon codicon-${typeInfo.icon}"></span>
      ${agentType}
    </span>
  `;
}

/**
 * Render agent category badge
 */
export function renderCategoryBadge(category) {
  const badgeClass =
    category === 'toolUse' ? 'badge-tooluse' : 'badge-workflow';
  const label = category === 'toolUse' ? 'Tool-Use' : 'Workflow';
  return `<span class="badge ${badgeClass}">${label}</span>`;
}

/**
 * Render agent source badge
 */
export function renderSourceBadge(source) {
  switch (source) {
    case 'custom':
      return '<span class="badge badge-custom">Custom</span>';
    case 'remote':
      return '<span class="badge badge-remote">Remote</span>';
    default:
      return '';
  }
}

/**
 * Render a single agent item
 */
export function renderAgentItem(agent, isEnabled, showActions = false) {
  const typeBadge = renderAgentTypeBadge(agent.agentType);
  const sourceBadge = renderSourceBadge(agent.source);
  const description = agent.description
    ? `<span class="agent-description">${agent.description}</span>`
    : '';

  const actions = showActions
    ? `
      <div class="agent-actions">
        <vscode-button appearance="secondary" data-agent="${agent.name}" data-action="source">
          Source
        </vscode-button>
        ${
          agent.source === 'custom'
            ? `<vscode-button appearance="secondary" data-agent="${agent.name}" data-action="delete">
                Delete
              </vscode-button>`
            : ''
        }
      </div>
    `
    : '';

  return `
    <div class="agent-item" data-agent-name="${agent.name}">
      <vscode-checkbox
        ${isEnabled ? 'checked' : ''}
        data-agent-name="${agent.name}"
        data-category="${agent.category}"
      >
      </vscode-checkbox>
      <div class="agent-info">
        <span class="agent-name">${agent.name}</span>
        ${description}
        <div class="agent-meta">
          ${typeBadge}
          ${sourceBadge}
          ${agent.rounds && agent.rounds > 1 ? `<span class="agent-rounds">x${agent.rounds}</span>` : ''}
          ${agent.inherits ? `<span class="agent-inherits"><span class="codicon codicon-extensions"></span> ${agent.inherits}</span>` : ''}
        </div>
      </div>
      ${actions}
    </div>
  `;
}

/**
 * Render a list of agents
 */
export function renderAgentList(agents, enabledSet, showActions = false) {
  if (!agents || agents.length === 0) {
    return '<p class="empty-state">No agents available</p>';
  }

  return agents
    .map((agent) =>
      renderAgentItem(agent, enabledSet.has(agent.name), showActions),
    )
    .join('');
}

/**
 * Filter agents by source
 */
export function filterAgentsBySource(agents, source) {
  return agents.filter((a) => a.source === source);
}

/**
 * Filter agents by category
 */
export function filterAgentsByCategory(agents, category) {
  return agents.filter((a) => a.category === category);
}
