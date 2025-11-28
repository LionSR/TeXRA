/* global document, console */
// Local imports - profile view
import { ELEMENT_IDS, LABELS, CLASS_NAMES, DEFAULTS } from '../constants.js';
import { PROFILE_VIEW_COMMANDS } from '@common/webview/commands.js';
import { vscode } from '@common/webviewContext.js';
import { safeGetElementById } from '@common/domUtils.js';

/**
 * Manages the agents table rendering and interactions.
 */
export class AgentsTable {
  constructor(state) {
    this.state = state;
    this._container = null;
    this._template = null;
    this._tagTemplate = null;
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

  get tagTemplate() {
    if (!this._tagTemplate) {
      this._tagTemplate = safeGetElementById('tagTemplate');
    }
    return this._tagTemplate;
  }

  /**
   * Render the profile view with the given data.
   */
  render(authenticated, user, tier, remoteAgents) {
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

    // Update tier badge
    const tierBadge = safeGetElementById(ELEMENT_IDS.USER_TIER);
    if (tierBadge) {
      tierBadge.textContent = tier;
      tierBadge.className = `${CLASS_NAMES.TIER_BADGE} ${tier}`;
    }

    // Update tier message
    const tierMessage = safeGetElementById(ELEMENT_IDS.TIER_MESSAGE);
    if (tierMessage) {
      tierMessage.textContent =
        tier === 'researcher'
          ? LABELS.TIER_RESEARCHER_MESSAGE
          : LABELS.TIER_FREE_MESSAGE;
    }

    // Show/hide remote agents section based on tier
    if (tier === 'researcher') {
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
        <th>Tags</th>
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

    // Set agent type badge
    const typeBadge = row.querySelector('.type-badge');
    if (typeBadge) {
      typeBadge.textContent = agent.agentType || DEFAULTS.AGENT_TYPE;
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

    // Set tags
    const tagsContainer = row.querySelector('.agent-tags');
    if (tagsContainer && agent.tags && agent.tags.length > 0) {
      agent.tags.forEach((tag) => {
        if (!this.tagTemplate) return;
        const tagEl = this.tagTemplate.content
          .cloneNode(true)
          .querySelector('.tag');
        if (tagEl) {
          tagEl.textContent = tag;
          tagsContainer.appendChild(tagEl);
        }
      });
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
