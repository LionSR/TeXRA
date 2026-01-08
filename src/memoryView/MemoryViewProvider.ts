// Third-party imports
import * as vscode from 'vscode';

// Local imports - common webview
import {
  BaseWebviewProvider,
  getSharedLocalResourceRoots,
} from '@common/webview';

// Local imports - memory view components
import { MemoryViewContentProvider } from './MemoryViewContentProvider';
import { MemoryViewMessageHandler } from './MemoryViewMessageHandler';

export class MemoryViewProvider
  extends BaseWebviewProvider
  implements vscode.WebviewViewProvider
{
  public static readonly viewType = 'texra.memoryView';
  protected contentProvider: MemoryViewContentProvider;
  protected messageHandler: MemoryViewMessageHandler;

  constructor(protected readonly context: vscode.ExtensionContext) {
    super(context);
    this.contentProvider = new MemoryViewContentProvider(context);
    this.messageHandler = new MemoryViewMessageHandler(context);
  }

  /**
   * Resolve webview for potential sidebar integration.
   */
  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: getSharedLocalResourceRoots(
        this.context,
        'memoryView',
      ),
    };

    super.resolveWebviewViewInternal(webviewView);
  }

  /**
   * Create and show the webview panel (for command palette activation)
   */
  public async showMemoryView(): Promise<void> {
    const isNew = this.createOrShowPanel({
      viewType: MemoryViewProvider.viewType,
      title: 'TeXRA Memory',
      viewPath: 'memoryView',
    });

    if (!isNew && this._view) {
      await this.messageHandler.sendMemoryData(this._view.webview);
    }
  }
}
