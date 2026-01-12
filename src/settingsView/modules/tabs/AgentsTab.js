/**
 * Agents Tab
 */
import { vscode } from '@common/webviewContext.js';
import { debounce } from '@common/debounce.js';
import { settingsViewState } from '../settingsViewState.js';
import { SETTINGS_VIEW_COMMANDS, ELEMENT_IDS } from '../constants.js';
import {
  renderAgentList,
  filterAgentsBySource,
} from '../uiManagers/AgentListRenderer.js';

export class AgentsTab {
  constructor() {
    this._elements = null;
    this._debouncedSave = debounce(() => this.saveAgents(), 500);
  }

  initialize() {
    this._elements = {
      builtInAgentsList: document.getElementById(
        ELEMENT_IDS.BUILT_IN_AGENTS_LIST,
      ),
      customAgentsList: document.getElementById(ELEMENT_IDS.CUSTOM_AGENTS_LIST),
      remoteAgentsList: document.getElementById(ELEMENT_IDS.REMOTE_AGENTS_LIST),
      remoteAgentsSection: document.getElementById(
        ELEMENT_IDS.REMOTE_AGENTS_SECTION,
      ),
      autoShowRemoteAgents: document.getElementById('autoShowRemoteAgents'),
      agentsSignInBtn: document.getElementById('agentsSignInBtn'),

      // Custom agents directory
      customAgentsPath: document.getElementById('customAgentsPath'),
      browseCustomAgentsDir: document.getElementById('browseCustomAgentsDir'),
      openCustomAgentsDir: document.getElementById('openCustomAgentsDir'),

      // Settings elements
      storageModeSelect: document.getElementById('storageModeSelect'),
      requireEditApproval: document.getElementById('requireEditApproval'),
      persistSessions: document.getElementById('persistSessions'),
      sessionRetentionSelect: document.getElementById('sessionRetentionSelect'),
      compactionThreshold: document.getElementById('compactionThreshold'),
      maxRetryAttempts: document.getElementById('maxRetryAttempts'),
      backoffDelay: document.getElementById('backoffDelay'),
    };

    this.populateSelectOptions();
    this.attachEventListeners();
  }

  /**
   * Populate select dropdowns with options from state (backend is single source of truth)
   */
  populateSelectOptions() {
    const options = settingsViewState.selectOptions;
    this.populateSelect('storageModeSelect', options.storageMode ?? []);
    this.populateSelect(
      'sessionRetentionSelect',
      options.sessionRetention ?? [],
    );
    this.populateSelect('maxRetryAttempts', options.maxRetryAttempts ?? []);
  }

  /**
   * Populate a vscode-single-select with options
   */
  populateSelect(id, options) {
    const select = this._elements[id];
    if (!select) return;

    // Clear existing options
    select.innerHTML = '';

    // Add options
    options.forEach((opt) => {
      const option = document.createElement('vscode-option');
      option.value = opt.value;
      option.textContent = opt.label;
      select.appendChild(option);
    });
  }

  attachEventListeners() {
    const {
      builtInAgentsList,
      customAgentsList,
      remoteAgentsList,
      agentsSignInBtn,
      autoShowRemoteAgents,
    } = this._elements;

    // Agent checkbox changes and button clicks for each list
    [builtInAgentsList, customAgentsList, remoteAgentsList].forEach((list) => {
      if (list) {
        list.addEventListener('change', (e) => {
          this.handleAgentToggle(e);
        });
        list.addEventListener('click', (e) => {
          this.handleAgentAction(e);
        });
      }
    });

    // Sign in button
    if (agentsSignInBtn) {
      agentsSignInBtn.addEventListener('click', () => {
        vscode.postMessage({ command: SETTINGS_VIEW_COMMANDS.SIGN_IN });
      });
    }

    // Auto-show remote agents checkbox
    if (autoShowRemoteAgents) {
      autoShowRemoteAgents.addEventListener('change', () => {
        vscode.postMessage({
          command: SETTINGS_VIEW_COMMANDS.SAVE_SETTING,
          key: 'texra.remoteAgents.autoShow',
          value: autoShowRemoteAgents.checked,
          target: 'global',
        });
      });
    }

    // Custom agents directory buttons
    const { browseCustomAgentsDir, openCustomAgentsDir } = this._elements;
    if (browseCustomAgentsDir) {
      browseCustomAgentsDir.addEventListener('click', () => {
        vscode.postMessage({
          command: SETTINGS_VIEW_COMMANDS.BROWSE_AGENTS_DIRECTORY,
        });
      });
    }
    if (openCustomAgentsDir) {
      openCustomAgentsDir.addEventListener('click', () => {
        vscode.postMessage({
          command: SETTINGS_VIEW_COMMANDS.OPEN_AGENTS_DIRECTORY,
        });
      });
    }

    // Tool-use settings
    this.attachSettingsEventListeners();
  }

  attachSettingsEventListeners() {
    const {
      storageModeSelect,
      requireEditApproval,
      persistSessions,
      sessionRetentionSelect,
      compactionThreshold,
      maxRetryAttempts,
      backoffDelay,
    } = this._elements;

    const saveSettingHandler = (key, valueGetter) => (e) => {
      vscode.postMessage({
        command: SETTINGS_VIEW_COMMANDS.SAVE_SETTING,
        key,
        value: valueGetter(e.target),
        target: 'workspace',
      });
    };

    if (storageModeSelect) {
      storageModeSelect.addEventListener(
        'change',
        saveSettingHandler('texra.agentOutputs.storageMode', (el) => el.value),
      );
    }

    if (requireEditApproval) {
      requireEditApproval.addEventListener(
        'change',
        saveSettingHandler(
          'texra.toolUse.requireEditApproval',
          (el) => el.checked,
        ),
      );
    }

    if (persistSessions) {
      persistSessions.addEventListener(
        'change',
        saveSettingHandler(
          'texra.toolUse.persistence.enabled',
          (el) => el.checked,
        ),
      );
    }

    if (sessionRetentionSelect) {
      sessionRetentionSelect.addEventListener(
        'change',
        saveSettingHandler('texra.toolUse.persistence.ttlHours', (el) =>
          parseInt(el.value, 10),
        ),
      );
    }

    if (compactionThreshold) {
      compactionThreshold.addEventListener(
        'change',
        saveSettingHandler('texra.model.compactionThresholdPercent', (el) =>
          parseInt(el.value, 10),
        ),
      );
    }

    if (maxRetryAttempts) {
      maxRetryAttempts.addEventListener(
        'change',
        saveSettingHandler('texra.model.retry.maxAttempts', (el) =>
          parseInt(el.value, 10),
        ),
      );
    }

    if (backoffDelay) {
      backoffDelay.addEventListener(
        'change',
        saveSettingHandler('texra.model.retry.backoffMs', (el) =>
          parseInt(el.value, 10),
        ),
      );
    }
  }

  handleAgentToggle(event) {
    const checkbox = event.target.closest('vscode-checkbox');
    if (!checkbox || !checkbox.dataset.agentName) return;

    const agentName = checkbox.dataset.agentName;
    const category = checkbox.dataset.category;
    const isEnabled = checkbox.checked;

    settingsViewState.toggleAgent(agentName, category, isEnabled);
    this._debouncedSave();
  }

  handleAgentAction(event) {
    const button = event.target.closest('vscode-button');
    if (!button || !button.dataset.action) return;

    const agentName = button.dataset.agent;
    const action = button.dataset.action;

    if (action === 'source') {
      vscode.postMessage({
        command: SETTINGS_VIEW_COMMANDS.OPEN_AGENT_SOURCE,
        agentName,
      });
    } else if (action === 'delete') {
      vscode.postMessage({
        command: SETTINGS_VIEW_COMMANDS.DELETE_AGENT,
        agentName,
      });
    }
  }

  saveAgents() {
    const enabledAgents = settingsViewState.getEnabledAgentsArray();
    const enabledToolUseAgents =
      settingsViewState.getEnabledToolUseAgentsArray();

    vscode.postMessage({
      command: SETTINGS_VIEW_COMMANDS.SAVE_ENABLED_AGENTS,
      agents: enabledAgents,
      toolUseAgents: enabledToolUseAgents,
    });
    settingsViewState.clearPendingChanges();
  }

  render(state) {
    this.renderBuiltInAgents(state);
    this.renderCustomAgents(state);
    this.renderRemoteAgents(state);
    this.renderCustomAgentsDirectory(state);
  }

  renderCustomAgentsDirectory(state) {
    const { customAgentsPath } = this._elements;
    if (!customAgentsPath) return;

    if (state.customAgentsDirectory) {
      customAgentsPath.textContent = state.customAgentsDirectory;
      customAgentsPath.title = state.customAgentsDirectory;
    } else {
      customAgentsPath.textContent = 'Default location';
    }
  }

  renderBuiltInAgents(state) {
    const { builtInAgentsList } = this._elements;
    if (!builtInAgentsList) return;

    const builtInAgents = [
      ...filterAgentsBySource(state.agents, 'builtIn'),
      ...filterAgentsBySource(state.agents, 'builtInToolUse'),
    ];

    // Combine enabled sets
    const enabledSet = new Set([
      ...state.enabledAgents,
      ...state.enabledToolUseAgents,
    ]);

    builtInAgentsList.innerHTML = renderAgentList(builtInAgents, enabledSet);
  }

  renderCustomAgents(state) {
    const { customAgentsList } = this._elements;
    if (!customAgentsList) return;

    const customAgents = filterAgentsBySource(state.agents, 'custom');
    const enabledSet = new Set([
      ...state.enabledAgents,
      ...state.enabledToolUseAgents,
    ]);

    if (customAgents.length === 0) {
      customAgentsList.innerHTML =
        '<p class="empty-state">No custom agents. Create them in <code>.texra/agents/</code></p>';
    } else {
      customAgentsList.innerHTML = renderAgentList(
        customAgents,
        enabledSet,
        true,
      );
    }
  }

  renderRemoteAgents(state) {
    const { remoteAgentsList, remoteAgentsSection } = this._elements;
    if (!remoteAgentsList || !remoteAgentsSection) return;

    const remoteAgents = filterAgentsBySource(state.agents, 'remote');

    // Show remote agents section if user is authenticated
    if (state.authenticated) {
      remoteAgentsSection.style.display = 'block';

      const enabledSet = new Set([
        ...state.enabledAgents,
        ...state.enabledToolUseAgents,
      ]);

      if (remoteAgents.length === 0) {
        remoteAgentsList.innerHTML =
          '<p class="empty-state">No remote agents available</p>';
      } else {
        remoteAgentsList.innerHTML = renderAgentList(remoteAgents, enabledSet);
      }
    } else {
      // Show sign-in prompt for remote agents
      remoteAgentsSection.style.display = 'block';
      remoteAgentsList.innerHTML = '';
      const signInPrompt = remoteAgentsSection.querySelector('.sign-in-prompt');
      if (signInPrompt) {
        signInPrompt.style.display = 'flex';
      }
    }
  }
}
