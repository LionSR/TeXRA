/**
 * Memory-settings domain handlers.
 *
 * Handles listing memory files, opening them (markdown in preview mode),
 * previewing a single entry, deleting, and pinning workspace memory from the
 * Settings view.
 */
import { Cause, Data, Effect, Exit } from 'effect';
import * as vscode from 'vscode';

import type { SessionHandle } from '@agent/runtime';
import { SettingsMemoryController } from '@controllers/settingsView/SettingsMemoryController';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import type { ProcessRuntime } from '@platform/processRuntime';
import { resolveMemoryStoragePath } from '@platform/defaults/workspaceStorage';
import { StorageFs, withSessionFs } from '@platform/rootedFs';

import { SETTINGS_VIEW_CMD, type SettingsMessageFor } from '@shared/schemas';
import { hasExtension } from '@utils/core/pathCore';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  withHandlerErrorHandling,
  type SettingsHandlerContext,
} from './SettingsHandlerContext';

/** A settings-view message the webview refused to accept. */
class MemoryMessageUndelivered extends Data.TaggedError(
  'MemoryMessageUndelivered',
)<{ readonly cause: unknown; readonly message: string }> {}

/** Memory-settings handler delegate. */
export class MemoryHandlers {
  constructor(
    private readonly ctx: SettingsHandlerContext,
    private readonly memory: SettingsMemoryController,
    private readonly viewName: string,
    private readonly runtime: ProcessRuntime,
    private readonly session: SessionHandle,
  ) {}

  async sendMemoryData(webview: vscode.Webview): Promise<void> {
    await webview.postMessage(
      await this.runtime.runPromise(this.memory.getMemoryDataMessage()),
    );
  }

  /**
   * Post one memory preview, or the preview's error placeholder when it
   * cannot be produced. Every outcome of the read-and-post — an unreadable
   * file, a rejected post — is reported and then answered with the
   * placeholder, so the view never waits on a preview that will not arrive.
   */
  async handleGetMemoryPreview(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.GET_MEMORY_PREVIEW>,
  ): Promise<void> {
    await this.ctx.withActiveWebview(async (webview) => {
      const delivered = await this.runtime.runPromise(
        Effect.exit(
          Effect.flatMap(
            this.memory.getMemoryPreviewMessage(data.storagePath),
            (preview) =>
              Effect.tryPromise({
                try: () => webview.postMessage(preview),
                catch: (cause) =>
                  new MemoryMessageUndelivered({
                    cause,
                    message: toErrorMessage(cause),
                  }),
              }),
          ),
        ),
      );
      if (Exit.isSuccess(delivered)) return;
      await showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to load memory preview',
        Cause.squash(delivered.cause),
      );
      await webview.postMessage(
        this.memory.getMemoryPreviewErrorMessage(data.storagePath),
      );
    });
  }

  async handleOpenMemoryFile(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.OPEN_MEMORY_FILE>,
  ): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to open memory file',
      async () => {
        const resolvedPath = resolveMemoryStoragePath(data.storagePath);
        const absolutePath = await this.runtime.runPromise(
          withSessionFs(
            this.session.roots,
            Effect.flatMap(Effect.service(StorageFs), (storageFs) =>
              storageFs.resolve(resolvedPath),
            ),
          ),
        );
        const fileUri = vscode.Uri.file(absolutePath);

        // Open markdown files in preview mode (read-only rendered view)
        if (hasExtension(absolutePath, '.md')) {
          await safeExecuteCommand(
            'markdown.showPreview',
            [fileUri],
            this.viewName,
          );
        } else {
          const doc = await vscode.workspace.openTextDocument(fileUri);
          await vscode.window.showTextDocument(doc, { preview: false });
        }
      },
    );
  }

  async handleOpenMemoryFolder(): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      'Failed to open memory folder',
      async () => {
        const resolvedPath = resolveMemoryStoragePath();
        // One program over the session's storage view: create the folder and
        // hand back the same view's absolute path for it.
        const absolutePath = await this.runtime.runPromise(
          withSessionFs(
            this.session.roots,
            Effect.flatMap(Effect.service(StorageFs), (storageFs) =>
              Effect.flatMap(
                storageFs.makeDirectory(resolvedPath, { recursive: true }),
                () => storageFs.resolve(resolvedPath),
              ),
            ),
          ),
        );
        await safeExecuteCommand(
          'revealFileInOS',
          [vscode.Uri.file(absolutePath)],
          this.viewName,
        );
      },
    );
  }

  async handleDeleteMemory(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_CMD.DELETE_MEMORY>,
  ): Promise<void> {
    const posted = await this.runtime.runPromise(
      Effect.exit(
        Effect.flatMap(this.memory.deleteMemory(data), (message) =>
          message == null
            ? Effect.void
            : Effect.tryPromise({
                try: () => this.ctx.postMessageToActiveWebview(message),
                catch: (cause) =>
                  new MemoryMessageUndelivered({
                    cause,
                    message: toErrorMessage(cause),
                  }),
              }),
        ),
      ),
    );
    if (Exit.isSuccess(posted)) return;
    await showLoggedErrorMessage(
      this.ctx.channel,
      'Failed to delete memory',
      Cause.squash(posted.cause),
    );
    await this.ctx.withActiveWebview((w) => this.sendMemoryData(w));
  }

  async setMemoryPinned(storagePath: string, pinned: boolean): Promise<void> {
    await withHandlerErrorHandling(
      this.ctx,
      `Failed to ${pinned ? 'pin' : 'unpin'} memory`,
      async () => {
        const message = await this.runtime.runPromise(
          this.memory.setMemoryPinned(storagePath, pinned),
        );
        if (message != null) {
          await this.ctx.postMessageToActiveWebview(message);
        }
      },
    );
  }
}
