/* global document, console */
// Local imports - profile view
import { ELEMENT_IDS, CLASS_NAMES } from '../constants.js';
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
   * @param {Array} options.remoteAgents - Array of remote agent objects
   * @param {string} options.apiAccessMode - 'included' or 'personal'
   * @param {string[]} options.enabledProviders - Array of enabled provider names
   * @param {string[]|null} options.allowedModels - Array of allowed model names (null = all for Ultra)
   * @param {string|null} options.accessExpiresAt - ISO date string when access expires (null = no expiration)
   */
  render({
    authenticated,
    user,
    tier,
    remoteAgents,
    apiAccessMode,
    enabledProviders,
    allowedModels,
    accessExpiresAt,
  }) {
    const profileInfo = safeGetElementById(ELEMENT_IDS.PROFILE_INFO);
    const notAuthenticated = safeGetElementById(ELEMENT_IDS.NOT_AUTHENTICATED);
    const remoteAgentsSection = safeGetElementById(
      ELEMENT_IDS.REMOTE_AGENTS_SECTION,
    );
    const noAgentsMessage = safeGetElementById(ELEMENT_IDS.NO_AGENTS_MESSAGE);
    const apiAccessSection = safeGetElementById(ELEMENT_IDS.API_ACCESS_SECTION);

    if (
      !profileInfo ||
      !notAuthenticated ||
      !remoteAgentsSection ||
      !noAgentsMessage
    ) {
      return;
    }

    if (!authenticated) {
      // Show not authenticated state
      profileInfo.style.display = 'none';
      notAuthenticated.style.display = 'block';
      remoteAgentsSection.style.display = 'none';
      if (apiAccessSection) apiAccessSection.style.display = 'none';
      return;
    }

    // Show authenticated state
    profileInfo.style.display = 'block';
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
      // Keep 'badge' base class for shared styling, add tier-badge and tier variant
      tierBadge.className = `badge ${CLASS_NAMES.TIER_BADGE} ${tier.toLowerCase()}`;
    }

    // Update access expiration display
    const expirationRow = safeGetElementById(ELEMENT_IDS.ACCESS_EXPIRATION_ROW);
    const expirationValue = safeGetElementById(ELEMENT_IDS.ACCESS_EXPIRATION);
    if (expirationRow && expirationValue) {
      if (accessExpiresAt) {
        const expirationDate = new Date(accessExpiresAt);
        expirationValue.textContent = expirationDate.toLocaleDateString(
          undefined,
          { year: 'numeric', month: 'short', day: 'numeric' },
        );
        expirationRow.style.display = 'flex';
      } else {
        // No expiration - don't show the row
        expirationRow.style.display = 'none';
      }
    }

    // Show API access section for all authenticated users
    // All tiers have some server-side access (free=budget, Max=mid-tier, Ultra=all)
    if (apiAccessSection) {
      apiAccessSection.style.display = 'block';
      this.renderApiAccessSection(
        apiAccessMode,
        enabledProviders,
        allowedModels,
      );
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
   * Render the API access section for all authenticated users.
   * All tiers have server-side access: free (budget), Max (mid-tier), Ultra (all).
   * @param {string} apiAccessMode - 'included' or 'personal'
   * @param {string[]} enabledProviders - Array of enabled provider names
   * @param {string[]|null} allowedModels - Array of allowed model names (null = all for Ultra)
   */
  renderApiAccessSection(apiAccessMode, enabledProviders, allowedModels) {
    const includedRadio = safeGetElementById(ELEMENT_IDS.API_ACCESS_INCLUDED);
    const personalRadio = safeGetElementById(ELEMENT_IDS.API_ACCESS_PERSONAL);
    const providersInfo = safeGetElementById(
      ELEMENT_IDS.ENABLED_PROVIDERS_INFO,
    );
    const modelsInfo = safeGetElementById(ELEMENT_IDS.ALLOWED_MODELS_INFO);
    const resolvedAllowedModels = Array.isArray(allowedModels)
      ? allowedModels
      : allowedModels === null
        ? null
        : [];

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
        providersInfo.textContent = `Providers: ${providerNames}`;
        providersInfo.style.display = 'block';
      } else {
        providersInfo.style.display = 'none';
      }
    }

    // Render model display section
    if (modelsInfo) {
      this.renderModelsDisplay(
        modelsInfo,
        apiAccessMode,
        resolvedAllowedModels,
        enabledProviders,
      );
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
   * Render the models display section based on access mode and allowed models.
   * @param {HTMLElement} modelsInfo - The models info container element
   * @param {string} apiAccessMode - 'included' or 'personal'
   * @param {string[]|null} allowedModels - Array of model names, or null for all models
   * @param {string[]} enabledProviders - Array of enabled provider names (for error detection)
   */
  renderModelsDisplay(
    modelsInfo,
    apiAccessMode,
    allowedModels,
    enabledProviders,
  ) {
    // allowedModels semantics:
    // - null: all models (Ultra tier)
    // - []: no models configured (error state)
    // - [...]: specific models allowed (Max and free tiers)
    if (apiAccessMode === 'included') {
      if (allowedModels === null) {
        // null means all models are allowed (Ultra tier)
        modelsInfo.textContent = 'All models included';
        modelsInfo.title = '';
        modelsInfo.style.display = 'block';
        this.clearModelsList(modelsInfo);
      } else if (allowedModels.length > 0) {
        // Specific models allowed - display count and list
        modelsInfo.textContent = `Models: ${allowedModels.length} included`;
        modelsInfo.title = '';
        modelsInfo.style.display = 'block';
        this.renderModelsList(modelsInfo, allowedModels);
      } else {
        // Empty array - config fetch failed or no models configured
        const configFetchFailed = enabledProviders.length === 0;
        modelsInfo.textContent = configFetchFailed
          ? 'Unable to load models'
          : 'No models configured';
        modelsInfo.title = configFetchFailed
          ? 'Try signing out and back in to refresh'
          : '';
        modelsInfo.style.display = 'block';
        this.clearModelsList(modelsInfo);
      }
    } else {
      // Personal mode - hide models info and clean up
      modelsInfo.style.display = 'none';
      this.clearModelsList(modelsInfo);
    }
  }

  /**
   * Clear any existing models list from the DOM.
   * @param {HTMLElement} container - The container element near the models list
   */
  clearModelsList(container) {
    const existingList =
      container?.parentElement?.querySelector('.models-list');
    if (existingList) {
      existingList.remove();
    }
  }

  /**
   * Render the list of allowed models as a formatted list.
   * @param {HTMLElement} container - The container element to append the list to
   * @param {string[]} models - Array of model names
   */
  renderModelsList(container, models) {
    // Remove any existing models list first
    this.clearModelsList(container);

    // Create the models list element
    const modelsList = document.createElement('div');
    modelsList.className = 'models-list';
    modelsList.textContent = models.join(', ');

    // Insert after the container (modelsInfo element)
    container.parentElement?.insertBefore(modelsList, container.nextSibling);
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
