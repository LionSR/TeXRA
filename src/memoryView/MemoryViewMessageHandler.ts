/**
 * Schema-driven message handler for MemoryView.
 *
 * Uses discriminated union validation at dispatch point (single safeParse)
 * with typed handler registry for type-safe message handling.
 */
import * as path from 'path';
import * as vscode from 'vscode';

import {
  dispatchMemoryViewInbound,
  type MemoryViewInboundHandlerRegistry,
  type MemoryViewInboundMessage,
  type MemoryViewItem,
} from '@shared/schemas/memoryViewMessages';
import { showLoggedErrorMessage } from '@common/errors';
import { BaseViewMessageHandler, MEMORY_VIEW_COMMANDS } from '@common/webview';
import {
  MEMORY_STORAGE_ROOT,
  MAX_PREVIEW_LINES,
  MAX_PREVIEW_CHARS,
  shouldSkipEntry,
} from '@tools/memory/constants';
import {
  relativeToDisplayPath,
  resolveMemoryStoragePath,
} from '@tools/memory/memoryUtils';
import { StorageFS } from '@utils/files';
import {
  getToolUseMemoryEnabled,
  setToolUseMemoryEnabled,
} from '@utils/config/constants';

// Type helper for extracting specific message types
type MessageFor<C extends MemoryViewInboundMessage['command']> = Extract<
  MemoryViewInboundMessage,
  { command: C }
>;

export class MemoryViewMessageHandler extends BaseViewMessageHandler<
  vscode.WebviewView | vscode.WebviewPanel
> {
  private readonly handlerRegistry: MemoryViewInboundHandlerRegistry;

  constructor(_context: vscode.ExtensionContext) {
    super('MemoryView', { trackActiveView: true });
    this.handlerRegistry = this.createHandlerRegistry();
  }

  protected createHandlers(): Record<string, never> {
    // Handler registry is created dynamically via createHandlerRegistry
    return {};
  }

  private createHandlerRegistry(): MemoryViewInboundHandlerRegistry {
    return {
      [MEMORY_VIEW_COMMANDS.GET_MEMORY_DATA]: () => this.handleGetMemoryData(),
      [MEMORY_VIEW_COMMANDS.OPEN_MEMORY_FILE]: (data) =>
        this.handleOpenMemoryFile(data),
      [MEMORY_VIEW_COMMANDS.OPEN_MEMORY_FOLDER]: () =>
        this.handleOpenMemoryFolder(),
      [MEMORY_VIEW_COMMANDS.DELETE_MEMORY]: (data) =>
        this.handleDeleteMemory(data),
      [MEMORY_VIEW_COMMANDS.GET_MEMORY_ENABLED]: () =>
        this.handleGetMemoryEnabled(),
      [MEMORY_VIEW_COMMANDS.SET_MEMORY_ENABLED]: (data) =>
        this.handleSetMemoryEnabled(data),
    };
  }

  public override async handleMessage(
    message: unknown,
    webviewView: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    // Track active view for handlers that need webview access
    this.setActiveView(webviewView);

    const handled = dispatchMemoryViewInbound(
      message,
      this.handlerRegistry,
      (error) => {
        this.logger.debug(this.channel, 'Message validation failed', {
          data: error,
        });
      },
    );

    if (
      !handled &&
      message &&
      typeof message === 'object' &&
      'command' in message
    ) {
      this.logger.warn(
        this.channel,
        `Unhandled command: ${(message as { command: string }).command}`,
      );
    }
  }

  // ============================================================
  // Public methods for external access
  // ============================================================

  public async sendMemoryData(webview: vscode.Webview): Promise<void> {
    const items = await this.loadMemoryItems();
    await webview.postMessage({
      command: MEMORY_VIEW_COMMANDS.UPDATE_MEMORY,
      items,
    });
  }

  public async sendMemoryEnabled(webview: vscode.Webview): Promise<void> {
    const enabled = getToolUseMemoryEnabled();
    await webview.postMessage({
      command: MEMORY_VIEW_COMMANDS.UPDATE_MEMORY_ENABLED,
      enabled,
    });
  }

  // ============================================================
  // Handler implementations
  // ============================================================

  private async handleGetMemoryData(): Promise<void> {
    const view = this.getActiveView();
    if (view) {
      await this.sendMemoryData(view.webview);
    }
  }

  private async handleOpenMemoryFile(
    data: MessageFor<typeof MEMORY_VIEW_COMMANDS.OPEN_MEMORY_FILE>,
  ): Promise<void> {
    try {
      const resolvedPath = resolveMemoryStoragePath(data.storagePath);
      const absolutePath = StorageFS.fullPath(resolvedPath);
      const doc = await vscode.workspace.openTextDocument(absolutePath);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to open memory file',
        error,
      );
    }
  }

  private async handleOpenMemoryFolder(): Promise<void> {
    try {
      await StorageFS.ensureDir(MEMORY_STORAGE_ROOT);
      const absolutePath = StorageFS.fullPath(MEMORY_STORAGE_ROOT);
      await vscode.commands.executeCommand(
        'revealFileInOS',
        vscode.Uri.file(absolutePath),
      );
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to open memory folder',
        error,
      );
    }
  }

  private async handleDeleteMemory(
    data: MessageFor<typeof MEMORY_VIEW_COMMANDS.DELETE_MEMORY>,
  ): Promise<void> {
    const view = this.getActiveView();

    const confirm = await vscode.window.showWarningMessage(
      `Delete "${data.displayPath}"?`,
      { modal: true },
      'Delete',
    );

    if (confirm !== 'Delete') {
      return;
    }

    try {
      const resolvedPath = resolveMemoryStoragePath(data.storagePath);
      await StorageFS.delete(resolvedPath, { recursive: true });
    } catch (error) {
      await showLoggedErrorMessage(
        this.channel,
        'Failed to delete memory',
        error,
      );
    } finally {
      // Always refresh the memory list to reflect current state
      if (view) {
        await this.sendMemoryData(view.webview);
      }
    }
  }

  private async handleGetMemoryEnabled(): Promise<void> {
    const view = this.getActiveView();
    if (view) {
      await this.sendMemoryEnabled(view.webview);
    }
  }

  private async handleSetMemoryEnabled(
    data: MessageFor<typeof MEMORY_VIEW_COMMANDS.SET_MEMORY_ENABLED>,
  ): Promise<void> {
    const view = this.getActiveView();
    await setToolUseMemoryEnabled(data.enabled);

    // Confirm the update back to the webview
    if (view) {
      await this.sendMemoryEnabled(view.webview);
    }
  }

  // ============================================================
  // Helper methods
  // ============================================================

  private async loadMemoryItems(): Promise<MemoryViewItem[]> {
    const exists = await StorageFS.exists(MEMORY_STORAGE_ROOT);
    if (!exists) {
      return [];
    }

    const items = await this.walkMemoryDirectory(MEMORY_STORAGE_ROOT);
    return items.sort((a, b) => b.mtime.localeCompare(a.mtime));
  }

  private async walkMemoryDirectory(
    storagePath: string,
    relativeRoot = '',
  ): Promise<MemoryViewItem[]> {
    const entries = await StorageFS.readDir(storagePath);
    const results: MemoryViewItem[] = [];

    for (const [name, type] of entries) {
      if (shouldSkipEntry(name)) {
        continue;
      }

      const nextRelative = relativeRoot ? path.join(relativeRoot, name) : name;
      const nextStoragePath = path.join(MEMORY_STORAGE_ROOT, nextRelative);

      if (type === vscode.FileType.Directory) {
        results.push(
          ...(await this.walkMemoryDirectory(nextStoragePath, nextRelative)),
        );
        continue;
      }

      const stats = await StorageFS.stat(nextStoragePath);
      const content = await StorageFS.read(nextStoragePath);
      const previewData = this.buildPreview(content);
      const displayPath = relativeToDisplayPath(nextRelative);

      results.push({
        displayPath,
        storagePath: nextStoragePath,
        size: stats.size,
        mtime: new Date(stats.mtime).toISOString(),
        lineCount: previewData.lineCount,
        preview: previewData.preview,
      });
    }

    return results;
  }

  private buildPreview(content: string): {
    preview: string;
    lineCount: number;
  } {
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines.at(-1) === '') {
      lines.pop();
    }

    const lineCount = lines.length;
    const previewLines = lines.slice(0, MAX_PREVIEW_LINES);
    let preview = previewLines.join('\n');
    let truncated = lineCount > MAX_PREVIEW_LINES;

    if (preview.length > MAX_PREVIEW_CHARS) {
      preview = preview.slice(0, MAX_PREVIEW_CHARS);
      truncated = true;
    }

    if (truncated) {
      preview = `${preview}\n...`;
    }

    return { preview, lineCount };
  }
}
