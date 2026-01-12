/**
 * Message Handlers for Settings View
 */
import { BaseWebviewMessageHandler } from '@common/BaseWebviewMessageHandler.js';
import { settingsViewState } from './settingsViewState.js';
import { settingsViewDomHandler } from './domHandlers.js';
import { SETTINGS_VIEW_COMMANDS, TAB_INDICES } from './constants.js';

class SettingsViewMessageHandler extends BaseWebviewMessageHandler {
  constructor() {
    super();
    this._handlers = {
      [SETTINGS_VIEW_COMMANDS.SET_INITIAL_DATA]: (m) =>
        this.handleSetInitialData(m),
      [SETTINGS_VIEW_COMMANDS.SET_ACCOUNT_DATA]: (m) =>
        this.handleSetAccountData(m),
      [SETTINGS_VIEW_COMMANDS.SET_MODELS_DATA]: (m) =>
        this.handleSetModelsData(m),
      [SETTINGS_VIEW_COMMANDS.SET_AGENTS_DATA]: (m) =>
        this.handleSetAgentsData(m),
      [SETTINGS_VIEW_COMMANDS.SET_HISTORY_DATA]: (m) =>
        this.handleSetHistoryData(m),
      [SETTINGS_VIEW_COMMANDS.SELECT_TAB]: (m) => this.handleSelectTab(m),
      [SETTINGS_VIEW_COMMANDS.HISTORY_CLEARED]: () =>
        this.handleHistoryCleared(),
      [SETTINGS_VIEW_COMMANDS.ERROR]: (m) => this.handleError(m),
    };
  }

  handleSetInitialData(message) {
    const { data } = message;
    settingsViewState.updateFromInitialData(data);

    // Render all tabs with initial data
    settingsViewDomHandler.headerBar.render(settingsViewState);
    settingsViewDomHandler.modelsTab.render(settingsViewState);
    settingsViewDomHandler.agentsTab.render(settingsViewState);
    settingsViewDomHandler.latexTab.render(settingsViewState);
    settingsViewDomHandler.memoryTab.render(settingsViewState);
    settingsViewDomHandler.historyTab.render(settingsViewState);
  }

  handleSetAccountData(message) {
    const { data } = message;
    settingsViewState.updateAccount(data);
    settingsViewDomHandler.headerBar.render(settingsViewState);
  }

  handleSetModelsData(message) {
    const { models, enabledModels, providers } = message;
    settingsViewState.updateModels(models, enabledModels, providers);
    settingsViewDomHandler.modelsTab.render(settingsViewState);
  }

  handleSetAgentsData(message) {
    const { agents, enabledAgents, enabledToolUseAgents } = message;
    settingsViewState.updateAgents(agents, enabledAgents, enabledToolUseAgents);
    settingsViewDomHandler.agentsTab.render(settingsViewState);
  }

  handleSetHistoryData(message) {
    const { historyItems } = message;
    settingsViewState.updateHistoryItems(historyItems);
    settingsViewDomHandler.historyTab.render(settingsViewState);
  }

  handleSelectTab(message) {
    const { tab } = message;
    const tabIndex = TAB_INDICES[tab];
    if (tabIndex !== undefined) {
      const tabsElement = document.getElementById('settingsTabs');
      if (tabsElement) {
        tabsElement.selectedIndex = tabIndex;
      }
      settingsViewState.selectedTab = tab;
    }
  }

  handleHistoryCleared() {
    settingsViewState.clearHistory();
    settingsViewDomHandler.historyTab.render(settingsViewState);
  }

  handleError(message) {
    console.error('Settings View Error:', message.message);
  }
}

export const messageHandler = new SettingsViewMessageHandler();
