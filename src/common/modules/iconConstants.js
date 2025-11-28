export const CHEVRON_UP_CLASS = 'codicon codicon-chevron-up';
export const CHEVRON_DOWN_CLASS = 'codicon codicon-chevron-down';
export const CHEVRON_RIGHT_CLASS = 'codicon codicon-chevron-right';

/**
 * Agent decorator configuration - single source of truth for all agent indicators.
 * Used across dropdown, stream tabs, and history view.
 *
 * Each decorator has:
 * - icon: codicon name for use in places that support HTML (stream tabs, etc.)
 * - unicode: unicode character for use in dropdowns (vscode-option only supports text)
 * - label: human-readable label
 * - hint: tooltip text (optional)
 */
export const AGENT_DECORATORS = {
  // Agent properties (remote, multiple outputs)
  properties: {
    remote: {
      icon: 'cloud',
      unicode: '☁',
      label: 'Remote',
      hint: 'Agent prompts loaded from remote',
    },
    multipleOutputs: {
      icon: 'files',
      unicode: '∶∶',
      label: 'Multiple outputs',
      hint: 'Generates multiple output files',
    },
  },

  // Agent types (reasoning strategy)
  types: {
    CoT: { icon: 'list-tree', unicode: '⊢', label: 'Chain of Thought' },
    direct: { icon: 'lightbulb', unicode: '◈', label: 'Direct' },
    toolUse: { icon: 'tools', unicode: '⚙', label: 'Tool Use' },
    unknown: { icon: 'question', unicode: '?', label: 'Unknown' },
  },

  // Session kinds (workflow vs tool-use category)
  sessionKinds: {
    workflow: { icon: 'symbol-method', unicode: '▷', label: 'Workflow' },
    toolUse: { icon: 'tools', unicode: '⚙', label: 'Tool Use' },
  },
};

/**
 * Build a codicon CSS class string from an icon name.
 * @param {string} iconName - Icon name (e.g., 'cloud', 'tools')
 * @returns {string} Full codicon class string
 */
export function getCodiconClass(iconName) {
  return `codicon codicon-${iconName}`;
}

/**
 * Apply codicon classes to an element.
 * @param {HTMLElement} element - The element to apply classes to
 * @param {string} iconName - Icon name (e.g., 'cloud', 'tools')
 */
export function applyCodiconClass(element, iconName) {
  element.classList.add('codicon', `codicon-${iconName}`);
}

/**
 * Get the decorator config for an agent type.
 * @param {string} agentType - Agent type key (CoT, direct, toolUse)
 * @returns {{ icon: string, label: string }}
 */
export function getAgentTypeDecorator(agentType) {
  return AGENT_DECORATORS.types[agentType] || AGENT_DECORATORS.types.unknown;
}

/**
 * Get the decorator config for a session kind.
 * @param {string} sessionKind - Session kind key (workflow, toolUse)
 * @returns {{ icon: string, label: string }}
 */
export function getSessionKindDecorator(sessionKind) {
  return (
    AGENT_DECORATORS.sessionKinds[sessionKind] ||
    AGENT_DECORATORS.sessionKinds.workflow
  );
}
