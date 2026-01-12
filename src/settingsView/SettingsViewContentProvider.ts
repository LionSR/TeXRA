// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { BaseViewContentProvider } from '@common/webview';

/** View-specific module descriptors for SettingsView */
const SETTINGS_VIEW_MODULES = [
  { key: 'settingsViewStateUri', path: 'modules/settingsViewState.js' },
  { key: 'headerBarUri', path: 'modules/uiManagers/HeaderBar.js' },
  { key: 'modelsTabUri', path: 'modules/tabs/ModelsTab.js' },
  { key: 'agentsTabUri', path: 'modules/tabs/AgentsTab.js' },
  { key: 'latexTabUri', path: 'modules/tabs/LatexTab.js' },
  { key: 'memoryTabUri', path: 'modules/tabs/MemoryTab.js' },
  { key: 'historyTabUri', path: 'modules/tabs/HistoryTab.js' },
  { key: 'modelListRendererUri', path: 'modules/uiManagers/ModelListRenderer.js' },
  { key: 'providerRendererUri', path: 'modules/uiManagers/ProviderRenderer.js' },
  { key: 'agentListRendererUri', path: 'modules/uiManagers/AgentListRenderer.js' },
  { key: 'settingRendererUri', path: 'modules/uiManagers/SettingRenderer.js' },
  { key: 'tabManagerUri', path: 'modules/TabManager.js' },
] as const;

export class SettingsViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'SettingsView', [...SETTINGS_VIEW_MODULES]);
  }

  protected getViewPath(): string {
    return 'settingsView';
  }
}
