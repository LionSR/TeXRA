/**
 * Tab Manager for Settings View
 */
import { vscode } from '@common/webviewContext.js';
import { settingsViewState } from './settingsViewState.js';
import { SETTINGS_VIEW_COMMANDS, TAB_INDICES } from './constants.js';

export class TabManager {
  constructor() {
    this._tabsElement = null;
  }

  initialize() {
    this._tabsElement = document.getElementById('settingsTabs');
    if (!this._tabsElement) return;

    // Listen for tab changes
    this._tabsElement.addEventListener('vsc-tabs-select', (e) => {
      this.handleTabChange(e);
    });

    // Restore selected tab from state
    const savedTab = settingsViewState.selectedTab;
    if (savedTab && TAB_INDICES[savedTab] !== undefined) {
      this._tabsElement.selectedIndex = TAB_INDICES[savedTab];
    }
  }

  handleTabChange(event) {
    const tabIndex =
      event.detail?.selectedIndex ?? this._tabsElement.selectedIndex;
    const tabName = Object.keys(TAB_INDICES).find(
      (key) => TAB_INDICES[key] === tabIndex,
    );

    if (tabName) {
      settingsViewState.selectedTab = tabName;

      // Notify extension of tab change
      vscode.postMessage({
        command: SETTINGS_VIEW_COMMANDS.TAB_CHANGED,
        tab: tabName,
      });
    }
  }

  selectTab(tabName) {
    const tabIndex = TAB_INDICES[tabName];
    if (tabIndex !== undefined && this._tabsElement) {
      this._tabsElement.selectedIndex = tabIndex;
      settingsViewState.selectedTab = tabName;
    }
  }
}
