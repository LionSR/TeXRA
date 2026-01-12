/**
 * Settings View State Management
 */
import { WebviewStateManager } from '@common/webviewState.js';

class SettingsViewState {
  constructor() {
    this.stateManager = new WebviewStateManager();

    // Account state
    this._authenticated = false;
    this._email = null;
    this._userId = null;
    this._tier = 'free';
    this._useIncludedAccess = true;

    // Models state
    this._models = [];
    this._enabledModels = new Set();
    this._providers = [];

    // Agents state
    this._agents = [];
    this._enabledAgents = new Set();
    this._enabledToolUseAgents = new Set();

    // LaTeX settings
    this._latexSettings = {};

    // Memory state
    this._memoryFiles = [];
    this._memoryEnabled = true;

    // History state
    this._historyItems = [];

    // UI state
    this._selectedTab = 'models';
    this._pendingChanges = false;

    // Select options (from backend - single source of truth)
    this._selectOptions = {};

    // Custom agents directory
    this._customAgentsDirectory = '';
  }

  /**
   * Initialize state from persisted storage
   */
  initialize() {
    const saved = this.stateManager.getState();
    if (saved) {
      this._selectedTab = saved.selectedTab ?? 'models';
    }
  }

  /**
   * Persist current state
   */
  save() {
    this.stateManager.update({
      selectedTab: this._selectedTab,
    });
  }

  // ===========================================================================
  // ACCOUNT STATE
  // ===========================================================================

  get authenticated() {
    return this._authenticated;
  }

  get email() {
    return this._email;
  }

  get userId() {
    return this._userId;
  }

  get tier() {
    return this._tier;
  }

  get useIncludedAccess() {
    return this._useIncludedAccess;
  }

  updateAccount(data) {
    this._authenticated = data.authenticated ?? false;
    this._email = data.email ?? null;
    this._userId = data.userId ?? null;
    this._tier = data.tier ?? 'free';
    this._useIncludedAccess = data.useIncludedAccess ?? true;
  }

  // ===========================================================================
  // MODELS STATE
  // ===========================================================================

  get models() {
    return this._models;
  }

  get enabledModels() {
    return this._enabledModels;
  }

  get providers() {
    return this._providers;
  }

  updateModels(models, enabledModels, providers) {
    this._models = models ?? [];
    this._enabledModels = new Set(enabledModels ?? []);
    this._providers = providers ?? [];
  }

  toggleModel(modelId, enabled) {
    if (enabled) {
      this._enabledModels.add(modelId);
    } else {
      this._enabledModels.delete(modelId);
    }
    this._pendingChanges = true;
  }

  getEnabledModelsArray() {
    return [...this._enabledModels];
  }

  getRecommendedModels() {
    return this._models.filter((m) => m.isRecommended);
  }

  getModelsByProvider(providerId) {
    return this._models.filter(
      (m) => m.provider.toLowerCase() === providerId.toLowerCase(),
    );
  }

  // ===========================================================================
  // AGENTS STATE
  // ===========================================================================

  get agents() {
    return this._agents;
  }

  get enabledAgents() {
    return this._enabledAgents;
  }

  get enabledToolUseAgents() {
    return this._enabledToolUseAgents;
  }

  updateAgents(agents, enabledAgents, enabledToolUseAgents) {
    this._agents = agents ?? [];
    this._enabledAgents = new Set(enabledAgents ?? []);
    this._enabledToolUseAgents = new Set(enabledToolUseAgents ?? []);
  }

  toggleAgent(agentName, category, enabled) {
    const targetSet =
      category === 'toolUse' ? this._enabledToolUseAgents : this._enabledAgents;

    if (enabled) {
      targetSet.add(agentName);
    } else {
      targetSet.delete(agentName);
    }
    this._pendingChanges = true;
  }

  getEnabledAgentsArray() {
    return [...this._enabledAgents];
  }

  getEnabledToolUseAgentsArray() {
    return [...this._enabledToolUseAgents];
  }

  getAgentsBySource(source) {
    return this._agents.filter((a) => a.source === source);
  }

  getAgentsByCategory(category) {
    return this._agents.filter((a) => a.category === category);
  }

  // ===========================================================================
  // LATEX SETTINGS
  // ===========================================================================

  get latexSettings() {
    return this._latexSettings;
  }

  updateLatexSettings(settings) {
    this._latexSettings = settings ?? {};
  }

  setLatexSetting(key, value) {
    this._latexSettings[key] = value;
    this._pendingChanges = true;
  }

  // ===========================================================================
  // MEMORY STATE
  // ===========================================================================

  get memoryFiles() {
    return this._memoryFiles;
  }

  get memoryEnabled() {
    return this._memoryEnabled;
  }

  updateMemoryFiles(files) {
    this._memoryFiles = files ?? [];
  }

  updateMemoryEnabled(enabled) {
    this._memoryEnabled = enabled ?? true;
  }

  // ===========================================================================
  // HISTORY STATE
  // ===========================================================================

  get historyItems() {
    return this._historyItems;
  }

  updateHistoryItems(items) {
    this._historyItems = items ?? [];
  }

  removeHistoryItem(id) {
    this._historyItems = this._historyItems.filter((item) => item.id !== id);
  }

  clearHistory() {
    this._historyItems = [];
  }

  // ===========================================================================
  // UI STATE
  // ===========================================================================

  get selectedTab() {
    return this._selectedTab;
  }

  set selectedTab(tab) {
    this._selectedTab = tab;
    this.save();
  }

  get pendingChanges() {
    return this._pendingChanges;
  }

  clearPendingChanges() {
    this._pendingChanges = false;
  }

  // ===========================================================================
  // SELECT OPTIONS (from backend)
  // ===========================================================================

  get selectOptions() {
    return this._selectOptions;
  }

  updateSelectOptions(options) {
    this._selectOptions = options ?? {};
  }

  /**
   * Get options for a specific dropdown
   */
  getSelectOptions(key) {
    return this._selectOptions[key] ?? [];
  }

  // ===========================================================================
  // CUSTOM AGENTS DIRECTORY
  // ===========================================================================

  get customAgentsDirectory() {
    return this._customAgentsDirectory;
  }

  updateCustomAgentsDirectory(path) {
    this._customAgentsDirectory = path ?? '';
  }

  // ===========================================================================
  // FULL STATE UPDATE
  // ===========================================================================

  updateFromInitialData(data) {
    this.updateAccount(data.account);
    this.updateModels(data.models, data.enabledModels, data.providers);
    this.updateAgents(
      data.agents,
      data.enabledAgents,
      data.enabledToolUseAgents,
    );
    this.updateLatexSettings(data.latexSettings);
    this.updateMemoryFiles(data.memoryFiles);
    this.updateMemoryEnabled(data.memoryEnabled);
    this.updateHistoryItems(data.history);
    this.updateSelectOptions(data.selectOptions);
    this.updateCustomAgentsDirectory(data.customAgentsDirectory);

    if (data.selectedTab) {
      this._selectedTab = data.selectedTab;
    }
  }
}

// Singleton instance
export const settingsViewState = new SettingsViewState();
