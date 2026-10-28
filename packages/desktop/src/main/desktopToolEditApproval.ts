/**
 * Desktop preview port for {@link ToolEditApprovalController}.
 *
 * Each request gets its own temp directory; the renderer opens the staged
 * copies through the window's diff and file viewers, and the user's edits are
 * read back from the proposed copy on disk, each time it is saved.
 */

// Third-party imports
import { Effect, FileSystem, Stream } from 'effect';

// Local imports - types
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { NotificationFailed, type DiffSource } from '@texra/hosts/uiHosts';
import type {
  ToolEditApprovalHost,
  ToolEditPreview,
  ToolEditPreviewRequest,
} from '@texra/controllers/approval/ToolEditApprovalController';
import { hostFailure } from '@texra/controllers/session/hostCallFailure';
import type { BuildDisplayFn } from '@texra/tools/latex/latexPreview';
import { writeApprovalTempFiles } from '@texra/tools/approval/tempFileManager';

import type { HostRequestFailure } from '@texra-ai/harness';

import type { DesktopAgentRunHost } from './desktopAgentRunHost.js';
import type { DesktopSpawn } from './desktopWindows.js';

type DesktopToolEditApprovalUi = Pick<
  DesktopAgentRunHost,
  'openPath' | 'openBuildDisplay' | 'showErrorMessage'
> & {
  /**
   * Show the staged diff under `previewId`, the key `closeDiff` below closes
   * it by. Each request names its own preview, so the Review workbench can
   * tell one request's diff from another's.
   */
  openDiff(
    original: DiffSource,
    proposed: DiffSource,
    title: string,
    previewId: string,
  ): Effect.Effect<void, Error>;
  /**
   * Take this request's staged diff off the Review workbench and nothing
   * else: settling here must not dismiss another request's pending preview
   * or an unrelated review, whichever of them the user is looking at.
   */
  closeDiff(previewId: string): Effect.Effect<void, never>;
};

interface DesktopToolEditApprovalHostOptions {
  ui: DesktopToolEditApprovalUi;
  /** Runs the error report on a fiber of the window's scope. */
  spawn: DesktopSpawn;
  /** Whether the window is focused and shows this project. */
  focused(): boolean;
}

export class DesktopToolEditApprovalHost implements ToolEditApprovalHost {
  private readonly options: DesktopToolEditApprovalHostOptions;
  constructor(options: DesktopToolEditApprovalHostOptions) {
    this.options = options;
  }

  get openBuildDisplay(): BuildDisplayFn {
    return this.options.ui.openBuildDisplay;
  }

  focused(): boolean {
    return this.options.focused();
  }

  stagePreview(
    request: ToolEditPreviewRequest,
  ): Effect.Effect<ToolEditPreview, HostRequestFailure, FileSystem.FileSystem> {
    const { ui } = this.options;
    return FileSystem.FileSystem.use((fs) =>
      fs.makeTempDirectory({ prefix: 'texra-tool-edit-' }),
    ).pipe(
      Effect.mapError((cause) => hostFailure('approval.createTempDir', cause)),
      Effect.flatMap((tempDir) =>
        writeApprovalTempFiles({
          directory: tempDir,
          targetPath: request.path,
          originalContent: request.originalContent,
          proposedContent: request.proposedContent,
        }).pipe(
          Effect.map(
            ({ originalPath, proposedPath }) =>
              new DesktopToolEditPreview(ui, request, {
                tempDir,
                originalPath,
                proposedPath,
              }),
          ),
          // A failed write leaves the directory it made; nothing else would
          // remove it, since the preview that owns it was never built.
          Effect.onError(() =>
            FileSystem.FileSystem.use((fs) =>
              fs.remove(tempDir, { recursive: true, force: true }),
            ).pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  `Could not remove the tool-edit preview directory ${tempDir}: ${toErrorMessage(error.reason.cause ?? error)}`,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  reportError(message: string): void {
    // Fire-and-forget, as the voided promise was; a dialog that cannot show
    // the report leaves a console trace instead of an unhandled rejection.
    this.options.spawn(
      this.options.ui.showErrorMessage(message).pipe(
        // The handler's parameter names the channel's whole error type, so a
        // second tag added here fails to compile instead of being dropped.
        Effect.catch((failure: NotificationFailed) =>
          Effect.sync(() => {
            console.error(
              `Tool-edit error report could not be shown: ${failure.message}`,
            );
          }),
        ),
      ),
    );
  }
}

interface DesktopStagedFiles {
  readonly tempDir: string;
  readonly originalPath: string;
  readonly proposedPath: string;
}

class DesktopToolEditPreview implements ToolEditPreview {
  private readonly ui: DesktopToolEditApprovalUi;
  private readonly request: ToolEditPreviewRequest;
  private readonly staged: DesktopStagedFiles;
  constructor(
    ui: DesktopToolEditApprovalUi,
    request: ToolEditPreviewRequest,
    staged: DesktopStagedFiles,
  ) {
    this.ui = ui;
    this.request = request;
    this.staged = staged;
  }

  get originalPath(): string {
    return this.staged.originalPath;
  }

  get proposedPath(): string {
    return this.staged.proposedPath;
  }

  showDiff(): Effect.Effect<void, HostRequestFailure> {
    return this.ui
      .openDiff(
        { filePath: this.staged.originalPath },
        { filePath: this.staged.proposedPath },
        `Tool edit: ${this.request.relativePath}`,
        this.request.requestId,
      )
      .pipe(
        Effect.mapError((cause) => hostFailure('approval.openDiff', cause)),
      );
  }

  openProposed(): Effect.Effect<void, HostRequestFailure> {
    return this.ui.openPath(this.staged.proposedPath);
  }

  /** The proposed copy each time it changes on disk: the user saved it. */
  get edits(): Stream.Stream<string, never, FileSystem.FileSystem> {
    return Stream.unwrap(
      FileSystem.FileSystem.use((fs) =>
        Effect.succeed(
          fs.watch(this.staged.proposedPath).pipe(
            Stream.mapEffect(() => fs.readFileString(this.staged.proposedPath)),
            Stream.changes,
          ),
        ),
      ),
    ).pipe(
      Stream.catch((error) =>
        Stream.fromEffect(
          Effect.logWarning(
            `Edits to ${this.staged.proposedPath} stopped reaching the session: ${toErrorMessage(error)}`,
          ),
        ).pipe(Stream.drain),
      ),
    );
  }

  readProposedContent(): Effect.Effect<
    string,
    HostRequestFailure,
    FileSystem.FileSystem
  > {
    return FileSystem.FileSystem.use((fs) =>
      fs.readFileString(this.staged.proposedPath),
    ).pipe(
      Effect.mapError((cause) => hostFailure('approval.readProposed', cause)),
    );
  }

  /**
   * Close the view before the files behind it go, in that order. The close
   * names this request's preview, so a request settling while the user reads
   * another diff takes only its own off the Review workbench.
   */
  dispose(): Effect.Effect<void, HostRequestFailure, FileSystem.FileSystem> {
    return this.ui
      .closeDiff(this.request.requestId)
      .pipe(
        Effect.andThen(
          FileSystem.FileSystem.use((fs) =>
            fs.remove(this.staged.tempDir, { recursive: true, force: true }),
          ).pipe(
            Effect.mapError((cause) =>
              hostFailure('approval.removeTempDir', cause),
            ),
          ),
        ),
      );
  }
}
