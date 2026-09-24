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
import type { SettingsViewInboundHandlerRegistry } from '@controllers/settingsView/settingsViewDispatch';
import { SettingsMemoryController } from '@controllers/settingsView/SettingsMemoryController';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { resolveMemoryStoragePath } from '@platform/defaults/workspaceStorage';
import { StorageFs, withSessionFs } from '@platform/rootedFs';

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsMessageFor } from '@shared/settingsView/settingsViewMessages';
import { hasExtension } from '@utils/core/pathCore';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import {
  postToWebview,
  withHandlerErrorHandling,
  type SettingsHandlerContext,
} from './SettingsHandlerContext';

/** A settings-view message the webview refused to accept. */
class MemoryMessageUndelivered extends Data.TaggedError(
  'MemoryMessageUndelivered',
)<{ readonly cause: unknown; readonly message: string }> {}

/** The Memory tab's inbound arms, spread into the settings-view registry. */
type MemoryTabHandlers = Pick<
  SettingsViewInboundHandlerRegistry,
  | typeof SETTINGS_VIEW_COMMANDS.GET_MEMORY_DATA
  | typeof SETTINGS_VIEW_COMMANDS.GET_MEMORY_PREVIEW
  | typeof SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FILE
  | typeof SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FOLDER
  | typeof SETTINGS_VIEW_COMMANDS.DELETE_MEMORY
  | typeof SETTINGS_VIEW_COMMANDS.PIN_MEMORY
  | typeof SETTINGS_VIEW_COMMANDS.UNPIN_MEMORY
>;

/** Memory-settings handler delegate. */
export class MemoryHandlers {
  readonly handlers: MemoryTabHandlers;

  constructor(
    private readonly ctx: SettingsHandlerContext,
    private readonly memory: SettingsMemoryController,
    private readonly viewName: string,
    private readonly session: SessionHandle,
  ) {
    // Each arm is a settings-view message, so its program settles on the
    // view's boundary here rather than in the view's own registry.
    this.handlers = {
      getMemoryData: () => ctx.withActiveWebview((w) => this.sendMemoryData(w)),
      getMemoryPreview: (message) => this.handleGetMemoryPreview(message),
      openMemoryFile: (message) => this.handleOpenMemoryFile(message),
      openMemoryFolder: () => this.handleOpenMemoryFolder(),
      deleteMemory: (message) => this.handleDeleteMemory(message),
      pinMemory: (message) => this.setMemoryPinned(message.storagePath, true),
      unpinMemory: (message) =>
        this.setMemoryPinned(message.storagePath, false),
    };
  }

  /** Every memory program below reads this session's storage view: the root
   *  is chosen here, at the host edge, not read inside the read. */
  private withStorage<A, E>(program: Effect.Effect<A, E, StorageFs>) {
    return withSessionFs(this.session.roots, program);
  }

  sendMemoryData(webview: vscode.Webview) {
    return Effect.flatMap(
      this.withStorage(this.memory.getMemoryDataMessage()),
      (message) => postToWebview(webview, message),
    );
  }

  /**
   * Post one memory preview, or the preview's error placeholder when it
   * cannot be produced. Every outcome of the read-and-post — an unreadable
   * file, a rejected post — is reported and then answered with the
   * placeholder, so the view never waits on a preview that will not arrive.
   */
  private handleGetMemoryPreview(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_COMMANDS.GET_MEMORY_PREVIEW>,
  ) {
    return this.ctx.withActiveWebview((webview) =>
      Effect.gen({ self: this }, function* () {
        const failure = yield* this.withStorage(
          Effect.flatMap(
            this.memory.getMemoryPreviewMessage(data.storagePath),
            (preview) =>
              postToWebview(webview, preview).pipe(
                Effect.mapError(
                  (cause) =>
                    new MemoryMessageUndelivered({
                      cause,
                      message: toErrorMessage(cause),
                    }),
                ),
              ),
          ).pipe(Effect.as(null), Effect.catch(Effect.succeed)),
        );
        if (failure === null) return;
        yield* showLoggedErrorMessage(
          this.ctx.channel,
          'Failed to load memory preview',
          failure,
        );
        yield* postToWebview(
          webview,
          this.memory.getMemoryPreviewErrorMessage(data.storagePath),
        );
      }),
    );
  }

  private handleOpenMemoryFile(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FILE>,
  ) {
    return withHandlerErrorHandling(
      this.ctx,
      'Failed to open memory file',
      Effect.gen({ self: this }, function* () {
        const resolvedPath = resolveMemoryStoragePath(data.storagePath);
        const absolutePath = yield* this.withStorage(
          Effect.flatMap(Effect.service(StorageFs), (storageFs) =>
            storageFs.resolve(resolvedPath),
          ),
        );
        const fileUri = vscode.Uri.file(absolutePath);

        // Open markdown files in preview mode (read-only rendered view)
        if (hasExtension(absolutePath, '.md')) {
          yield* safeExecuteCommand(
            'markdown.showPreview',
            [fileUri],
            this.viewName,
          );
          return;
        }
        yield* Effect.tryPromise({
          try: async () => {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(doc, { preview: false });
          },
          catch: ensureError,
        });
      }),
    );
  }

  private handleOpenMemoryFolder() {
    const resolvedPath = resolveMemoryStoragePath();
    return withHandlerErrorHandling(
      this.ctx,
      'Failed to open memory folder',
      // One program over the session's storage view: create the folder and
      // hand back the same view's absolute path for it.
      Effect.flatMap(
        this.withStorage(
          Effect.flatMap(Effect.service(StorageFs), (storageFs) =>
            Effect.flatMap(
              storageFs.makeDirectory(resolvedPath, { recursive: true }),
              () => storageFs.resolve(resolvedPath),
            ),
          ),
        ),
        (absolutePath) =>
          safeExecuteCommand(
            'revealFileInOS',
            [vscode.Uri.file(absolutePath)],
            this.viewName,
          ),
      ),
    );
  }

  private handleDeleteMemory(
    data: SettingsMessageFor<typeof SETTINGS_VIEW_COMMANDS.DELETE_MEMORY>,
  ) {
    return Effect.gen({ self: this }, function* () {
      const posted = yield* this.withStorage(
        Effect.exit(
          Effect.flatMap(this.memory.deleteMemory(data), (message) =>
            message == null
              ? Effect.void
              : this.ctx.postMessageToActiveWebview(message).pipe(
                  Effect.mapError(
                    (cause) =>
                      new MemoryMessageUndelivered({
                        cause,
                        message: toErrorMessage(cause),
                      }),
                  ),
                ),
          ),
        ),
      );
      if (Exit.isSuccess(posted)) return;
      yield* showLoggedErrorMessage(
        this.ctx.channel,
        'Failed to delete memory',
        Cause.squash(posted.cause),
      );
      yield* this.ctx.withActiveWebview((w) => this.sendMemoryData(w));
    });
  }

  private setMemoryPinned(storagePath: string, pinned: boolean) {
    return withHandlerErrorHandling(
      this.ctx,
      `Failed to ${pinned ? 'pin' : 'unpin'} memory`,
      Effect.flatMap(
        this.withStorage(this.memory.setMemoryPinned(storagePath, pinned)),
        (message) =>
          message == null
            ? Effect.void
            : this.ctx.postMessageToActiveWebview(message),
      ),
    );
  }
}
