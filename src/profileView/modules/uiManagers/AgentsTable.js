/* global document, console */
// Local imports - profile view
import { ELEMENT_IDS, LABELS, CLASS_NAMES, DEFAULTS } from '../constants.js';
import { PROFILE_VIEW_COMMANDS } from '@common/webview/commands.js';
import { vscode } from '@common/webviewContext.js';
import { safeGetElementById } from '@common/domUtils.js';

/**
 * Permission constant for accessing remote agents.
 * Matches PERMISSIONS.ACCESS_REMOTE_AGENTS from config.ts
 */
const PERMISSION_ACCESS_REMOTE_AGENTS = 'access_remote_agents';

/**
 * Check if a permission array includes a specific permission.
 * @param {string[]} permissions - Array of permission strings
 * @param {string} permission - Permission to check for
 * @returns {boolean}
 */
function hasPermission(permissions, permission) {
  return Array.isArray(permissions) && permissions.includes(permission);
}

/**
 * Manages the agents table rendering and interactions.
 */
export class AgentsTable {
  constructor(state) {
    this.state = state;
    this._container = null;
    this._template = null;
  }

  get container() {
    if (!this._container) {
      this._container = safeGetElementById(ELEMENT_IDS.AGENTS_TABLE_CONTAINER);
    }
    return this._container;
  }

  get template() {
    if (!this._template) {
      this._template = safeGetElementById('agentRowTemplate');
    }
    return this._template;
  }

  /**
   * Render the profile view with the given data.
   * @param {boolean} authenticated - Whether the user is authenticated
   * @param {object} user - User object with email and id
   * @param {string} tier - Primary group name (for backwards compatibility / display)
   * @param {string[]} permissions - Array of permission strings
   * @param {Array} remoteAgents - Array of remote agent objects
   */
  render(authenticated, user, tier, permissions, remoteAgents) {
    const profileInfo = safeGetElementById(ELEMENT_IDS.PROFILE_INFO);
    const tierInfo = safeGetElementById(ELEMENT_IDS.TIER_INFO);
    const notAuthenticated = safeGetElementById(ELEMENT_IDS.NOT_AUTHENTICATED);
    const remoteAgentsSection = safeGetElementById(
      ELEMENT_IDS.REMOTE_AGENTS_SECTION,
    );
    const noAgentsMessage = safeGetElementById(ELEMENT_IDS.NO_AGENTS_MESSAGE);

    if (
      !profileInfo ||
      !tierInfo ||
      !notAuthenticated ||
      !remoteAgentsSection ||
      !noAgentsMessage
    ) {
      return;
    }

    if (!authenticated) {
      // Show not authenticated state
      profileInfo.style.display = 'none';
      tierInfo.style.display = 'none';
      notAuthenticated.style.display = 'block';
      remoteAgentsSection.style.display = 'none';
      return;
    }

    // Show authenticated state
    profileInfo.style.display = 'block';
    tierInfo.style.display = 'block';
    notAuthenticated.style.display = 'none';

    // Update user info
    const userEmail = safeGetElementById(ELEMENT_IDS.USER_EMAIL);
    const userId = safeGetElementById(ELEMENT_IDS.USER_ID);
    if (userEmail) userEmail.textContent = user?.email || 'N/A';
    if (userId) userId.textContent = user?.id || '';

    // Update tier badge (shows primary group for display)
    const tierBadge = safeGetElementById(ELEMENT_IDS.USER_TIER);
    if (tierBadge) {
      tierBadge.textContent = tier;
      tierBadge.className = `${CLASS_NAMES.TIER_BADGE} ${tier}`;
    }

    // Update tier message based on permissions (not hardcoded tier check)
    const tierMessage = safeGetElementById(ELEMENT_IDS.TIER_MESSAGE);
    if (tierMessage) {
      const canAccessRemote = hasPermission(
        permissions,
        PERMISSION_ACCESS_REMOTE_AGENTS,
      );
      tierMessage.textContent = canAccessRemote
        ? LABELS.TIER_RESEARCHER_MESSAGE
        : LABELS.TIER_FREE_MESSAGE;
    }

    // Show/hide remote agents section based on permission (not tier)
    const canAccessRemoteAgents = hasPermission(
      permissions,
      PERMISSION_ACCESS_REMOTE_AGENTS,
    );

    if (canAccessRemoteAgents) {
      remoteAgentsSection.style.display = 'block';

      if (remoteAgents && remoteAgents.length > 0) {
        this.renderAgentsTable(remoteAgents);
        noAgentsMessage.style.display = 'none';
      } else {
        if (this.container) this.container.innerHTML = '';
        noAgentsMessage.style.display = 'block';
      }
    } else {
      remoteAgentsSection.style.display = 'none';
    }
  }

  /**
   * Render the agents table with the given agents.
   */
  renderAgentsTable(agents) {
    // Create table structure
    const table = document.createElement('table');
    table.className = 'agents-table';

    // Create header
    const thead = document.createElement('thead');
    thead.innerHTML = `
      <tr>
        <th>Agent</th>
        <th>Type</th>
        <th>Description</th>
        <th>Visibility</th>
        <th>Action</th>
      </tr>
    `;
    table.appendChild(thead);

    // Create body
    const tbody = document.createElement('tbody');

    agents.forEach((agent) => {
      const row = this.createAgentRow(agent);
      tbody.appendChild(row);
    });

    table.appendChild(tbody);

    // Clear and append
    if (this.container) {
      this.container.innerHTML = '';
      this.container.appendChild(table);
    }
  }

  /**
   * Create a table row for an agent.
   */
  createAgentRow(agent) {
    if (!this.template) {
      console.error('Agent row template not found');
      return document.createElement('tr');
    }

    const row = this.template.content.cloneNode(true).querySelector('tr');
    if (!row) {
      console.error('Could not clone agent row from template');
      return document.createElement('tr');
    }

    // Set agent name
    const agentName = row.querySelector('.agent-name');
    if (agentName) agentName.textContent = agent.name;

    // Set agent category badge (workflow or toolUse)
    const typeBadge = row.querySelector('.type-badge');
    if (typeBadge) {
      typeBadge.textContent = agent.category || DEFAULTS.AGENT_CATEGORY;
    }

    // Set description
    const description = row.querySelector('.agent-description');
    if (description) description.textContent = agent.description;

    // Set visibility badge
    const visibilityBadge = row.querySelector('.visibility-badge');
    if (visibilityBadge) {
      visibilityBadge.textContent = agent.visibility;
      visibilityBadge.classList.add(agent.visibility);
    }

    // Set up select button
    const selectBtn = row.querySelector('.select-btn');
    if (selectBtn) {
      selectBtn.addEventListener('click', () => {
        this.selectAgent(agent.name);
      });
    }

    return row;
  }

  /**
   * Send message to select an agent in the main view.
   */
  selectAgent(agentName) {
    vscode.postMessage({
      command: PROFILE_VIEW_COMMANDS.SELECT_AGENT,
      agentName: agentName,
    });
  }
}
