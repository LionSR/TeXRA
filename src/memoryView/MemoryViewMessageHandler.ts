// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { showLoggedErrorMessage } from '@common/errors';
import {
  BaseViewMessageHandler,
  type MessageHandler,
  MEMORY_VIEW_COMMANDS,
} from '@common/webview';

// Local imports - shared memory constants and utilities
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

// Local imports - storage
import { StorageFS } from '@utils/files';

// Local imports - schemas
import {
  MemoryPathMessageSchema,
  MemoryDeleteMessageSchema,
} from '@webview/types/messages';

interface MemoryViewItem {
  displayPath: string;
  storagePath: string;
  size: number;
  mtime: string;
  lineCount: number;
  preview: string;
}

export class MemoryViewMessageHandler extends BaseViewMessageHandler<
  vscode.WebviewView | vscode.WebviewPanel
> {
  constructor(_context: vscode.ExtensionContext) {
    super('MemoryView');
  }

  protected createHandlers(): Record<
    string,
    MessageHandler<vscode.WebviewView | vscode.WebviewPanel>
  > {
    return {
      [MEMORY_VIEW_COMMANDS.GET_MEMORY_DATA]:
        this.handleGetMemoryData.bind(this),
      [MEMORY_VIEW_COMMANDS.OPEN_MEMORY_FILE]:
        this.handleOpenMemoryFile.bind(this),
      [MEMORY_VIEW_COMMANDS.OPEN_MEMORY_FOLDER]:
        this.handleOpenMemoryFolder.bind(this),
      [MEMORY_VIEW_COMMANDS.DELETE_MEMORY]:
        this.handleDeleteMemory.bind(this),
    };
  }

  public async sendMemoryData(webview: vscode.Webview): Promise<void> {
    const items = await this.loadMemoryItems();
    await webview.postMessage({
      command: MEMORY_VIEW_COMMANDS.UPDATE_MEMORY,
      items,
    });
  }

  private async handleGetMemoryData(
    _message: unknown,
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.sendMemoryData(view.webview);
  }

  private async handleOpenMemoryFile(
    message: unknown,
    _view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.withValidatedMessage(
      MemoryPathMessageSchema,
      message,
      'openMemoryFile',
      async ({ storagePath }) => {
        try {
          const resolvedPath = resolveMemoryStoragePath(storagePath);
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
      },
    );
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
    message: unknown,
    view: vscode.WebviewView | vscode.WebviewPanel,
  ): Promise<void> {
    await this.withValidatedMessage(
      MemoryDeleteMessageSchema,
      message,
      'deleteMemory',
      async ({ storagePath, displayPath }) => {
        const confirm = await vscode.window.showWarningMessage(
          `Delete "${displayPath}"?`,
          { modal: true },
          'Delete',
        );

        if (confirm !== 'Delete') {
          return;
        }

        try {
          const resolvedPath = resolveMemoryStoragePath(storagePath);
          await StorageFS.delete(resolvedPath, { recursive: true });
          // Refresh the memory list after deletion
          await this.sendMemoryData(view.webview);
        } catch (error) {
          await showLoggedErrorMessage(
            this.channel,
            'Failed to delete memory',
            error,
          );
        }
      },
    );
  }

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
