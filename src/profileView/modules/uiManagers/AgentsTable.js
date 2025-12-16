/* global document, console */
// Local imports - profile view
import { ELEMENT_IDS, LABELS, CLASS_NAMES } from '../constants.js';
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
   * @param {Object} options - Render options
   * @param {boolean} options.authenticated - Whether the user is authenticated
   * @param {object} options.user - User object with email and id
   * @param {string} options.tier - Primary group name (for backwards compatibility / display)
   * @param {string[]} options.permissions - Array of permission strings
   * @param {Array} options.remoteAgents - Array of remote agent objects
   * @param {string} options.apiAccessMode - 'included' or 'personal'
   * @param {string[]} options.enabledProviders - Array of enabled provider names
   */
  render({
    authenticated,
    user,
    tier,
    permissions,
    remoteAgents,
    apiAccessMode,
    enabledProviders,
  }) {
    const profileInfo = safeGetElementById(ELEMENT_IDS.PROFILE_INFO);
    const tierInfo = safeGetElementById(ELEMENT_IDS.TIER_INFO);
    const notAuthenticated = safeGetElementById(ELEMENT_IDS.NOT_AUTHENTICATED);
    const remoteAgentsSection = safeGetElementById(
      ELEMENT_IDS.REMOTE_AGENTS_SECTION,
    );
    const noAgentsMessage = safeGetElementById(ELEMENT_IDS.NO_AGENTS_MESSAGE);
    const apiAccessSection = safeGetElementById(ELEMENT_IDS.API_ACCESS_SECTION);

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
      if (apiAccessSection) apiAccessSection.style.display = 'none';
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
      // Normalize tier to lowercase for CSS class consistency
      tierBadge.className = `${CLASS_NAMES.TIER_BADGE} ${tier.toLowerCase()}`;
    }

    // Update tier message based on whether user has any permissions
    const tierMessage = safeGetElementById(ELEMENT_IDS.TIER_MESSAGE);
    if (tierMessage) {
      const hasAnyPermissions =
        Array.isArray(permissions) && permissions.length > 0;
      tierMessage.textContent = hasAnyPermissions
        ? LABELS.TIER_PREMIUM_MESSAGE
        : LABELS.TIER_FREE_MESSAGE;
    }

    // Show API access section only for Ultra tier
    if (apiAccessSection) {
      const isUltra = tier === 'Ultra';
      apiAccessSection.style.display = isUltra ? 'block' : 'none';

      if (isUltra) {
        this.renderApiAccessSection(apiAccessMode, enabledProviders);
      }
    }

    // Show remote agents section for all authenticated users
    // RLS filters which agents they can see based on permissions
    remoteAgentsSection.style.display = 'block';

    if (remoteAgents && remoteAgents.length > 0) {
      this.renderAgentsTable(remoteAgents);
      noAgentsMessage.style.display = 'none';
    } else {
      if (this.container) this.container.innerHTML = '';
      noAgentsMessage.style.display = 'block';
    }
  }

  /**
   * Render the API access section for Ultra tier users.
   * @param {string} apiAccessMode - 'included' or 'personal'
   * @param {string[]} enabledProviders - Array of enabled provider names
   */
  renderApiAccessSection(apiAccessMode, enabledProviders) {
    const includedRadio = safeGetElementById(ELEMENT_IDS.API_ACCESS_INCLUDED);
    const personalRadio = safeGetElementById(ELEMENT_IDS.API_ACCESS_PERSONAL);
    const providersInfo = safeGetElementById(
      ELEMENT_IDS.ENABLED_PROVIDERS_INFO,
    );

    // Set the current mode
    if (includedRadio) {
      includedRadio.checked = apiAccessMode === 'included';
    }
    if (personalRadio) {
      personalRadio.checked = apiAccessMode === 'personal';
    }

    // Show enabled providers info when using included access
    if (providersInfo) {
      if (
        apiAccessMode === 'included' &&
        enabledProviders &&
        enabledProviders.length > 0
      ) {
        const providerNames = enabledProviders
          .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
          .join(', ');
        providersInfo.textContent = `Available: ${providerNames}`;
        providersInfo.style.display = 'block';
      } else {
        providersInfo.style.display = 'none';
      }
    }

    // Add event listeners (only once)
    if (!this._apiAccessListenersAdded) {
      this._apiAccessListenersAdded = true;

      if (includedRadio) {
        includedRadio.addEventListener('change', () => {
          if (includedRadio.checked) {
            this.setApiAccessMode('included');
          }
        });
      }

      if (personalRadio) {
        personalRadio.addEventListener('change', () => {
          if (personalRadio.checked) {
            this.setApiAccessMode('personal');
          }
        });
      }
    }
  }

  /**
   * Send message to change API access mode.
   * @param {string} mode - 'included' or 'personal'
   */
  setApiAccessMode(mode) {
    vscode.postMessage({
      command: PROFILE_VIEW_COMMANDS.SET_API_ACCESS_MODE,
      mode,
    });
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
        <th>Category</th>
        <th>Multi-Output</th>
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
    const categoryBadge = row.querySelector('.category-badge');
    if (categoryBadge) {
      categoryBadge.textContent = agent.category;
    }

    // Set multi-output badge with codicon and aria-label for accessibility
    const multiOutputBadge = row.querySelector('.multi-output-badge');
    if (multiOutputBadge) {
      const icon = document.createElement('span');
      icon.className = 'codicon';
      if (agent.supportsMultipleOutput) {
        icon.classList.add('codicon-check');
        multiOutputBadge.classList.add('supported');
        multiOutputBadge.setAttribute(
          'aria-label',
          'Supports multiple outputs',
        );
      } else {
        icon.classList.add('codicon-close');
        multiOutputBadge.classList.add('not-supported');
        multiOutputBadge.setAttribute('aria-label', 'Single output only');
      }
      multiOutputBadge.appendChild(icon);
    }

    // Set description
    const description = row.querySelector('.agent-description');
    if (description) description.textContent = agent.description;

    // Set visibility badge (handles both string and array)
    const visibilityBadge = row.querySelector('.visibility-badge');
    if (visibilityBadge) {
      const visibilityArray = Array.isArray(agent.visibility)
        ? agent.visibility
        : [agent.visibility];
      visibilityBadge.textContent = visibilityArray.join(', ');
      // Use first visibility value for CSS class, or 'custom' for non-public values
      const firstVisibility = visibilityArray[0] || 'public';
      const cssClass = firstVisibility === 'public' ? 'public' : 'custom';
      visibilityBadge.classList.add(cssClass);
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
