// Third-party imports
import * as vscode from 'vscode';

// Local imports - memory view
import { BaseViewContentProvider } from '@common/webview';

/** View-specific module descriptors for MemoryView */
const MEMORY_VIEW_MODULES = [
  { key: 'eventsUri', path: 'modules/uiManagers/MemoryEventsManager.js' },
  { key: 'memoryRendererUri', path: 'modules/uiManagers/MemoryRenderer.js' },
  { key: 'memoryViewStateUri', path: 'modules/memoryViewState.js' },
] as const;

export class MemoryViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'MemoryView', [...MEMORY_VIEW_MODULES]);
  }

  protected getViewPath(): string {
    return 'memoryView';
  }
}
