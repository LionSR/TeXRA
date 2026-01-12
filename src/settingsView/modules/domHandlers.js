/**
 * DOM Handlers for Settings View
 */
import { BaseDomHandler } from '@common/BaseDomHandler.js';
import { HeaderBar } from './uiManagers/HeaderBar.js';
import { ModelsTab } from './tabs/ModelsTab.js';
import { AgentsTab } from './tabs/AgentsTab.js';
import { LatexTab } from './tabs/LatexTab.js';
import { MemoryTab } from './tabs/MemoryTab.js';
import { HistoryTab } from './tabs/HistoryTab.js';
import { TabManager } from './TabManager.js';

/**
 * Main DOM handler for Settings View
 */
class SettingsViewDomHandler extends BaseDomHandler {
  constructor() {
    const headerBar = new HeaderBar();
    const modelsTab = new ModelsTab();
    const agentsTab = new AgentsTab();
    const latexTab = new LatexTab();
    const memoryTab = new MemoryTab();
    const historyTab = new HistoryTab();
    const tabManager = new TabManager();

    super({
      headerBar,
      modelsTab,
      agentsTab,
      latexTab,
      memoryTab,
      historyTab,
      tabManager,
    });
  }

  /**
   * Initialize all components
   */
  initialize() {
    this.headerBar.initialize();
    this.modelsTab.initialize();
    this.agentsTab.initialize();
    this.latexTab.initialize();
    this.memoryTab.initialize();
    this.historyTab.initialize();
    this.tabManager.initialize();
  }
}

export const settingsViewDomHandler = new SettingsViewDomHandler();
