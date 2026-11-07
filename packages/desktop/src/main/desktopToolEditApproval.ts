/**
 * Desktop preview port for {@link ToolEditApprovalController}.
 *
 * Each request gets its own temp directory; the renderer opens the staged
 * copies through the window's diff and file viewers, and an approval reads
 * the user's edits back from the proposed copy on disk, where the editor
 * the desktop opened it in saved them.
 */

// Third-party imports
import { Effect, FileSystem } from 'effect';

// Local imports - types
import { withLogChannel } from '@texra-ai/harness/host';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import {
  HostFailed,
  type DiffLabel,
  type DiffSource,
} from '@texra/hosts/uiHosts';
import { toolEditDiffLabel } from '@ui/copy/toolEditPreview';
import type {
  ToolEditApprovalHost,
  ToolEditPreview,
  ToolEditPreviewRequest,
} from '@texra/controllers/approval/ToolEditApprovalController';
import { hostFailure } from '@texra/controllers/session/hostCallFailure';
import type { BuildDisplayFn } from '@texra/tools/latex/latexPreview';
import { writeApprovalTempFiles } from '@texra/tools/approval/tempFileManager';
import { UNAPPLIED_TOOL_EDIT } from '@ui/copy/toolEditPreview';

import type { HostCommandFailure } from '@texra-ai/harness';

import type { DesktopAgentRunHost } from './desktopAgentRunHost.js';
import type { DesktopSpawn } from './desktopWindows.js';

type DesktopToolEditApprovalUi = Pick<
  DesktopAgentRunHost,
  'openPath' | 'openBuildDisplay' | 'showErrorMessage' | 'showWarningMessage'
> & {
  /**
   * Show the staged diff under `previewId`, the key `closeDiff` below closes
   * it by. Each request names its own preview, so the Review workbench can
   * tell one request's diff from another's.
   */
  openDiff(
    original: DiffSource,
    proposed: DiffSource,
    label: DiffLabel,
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
  /** Runs the error report and the notices on a fiber of the window's
   *  scope. */
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
  ): Effect.Effect<ToolEditPreview, HostCommandFailure, FileSystem.FileSystem> {
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
              new DesktopToolEditPreview(
                ui,
                request,
                { tempDir, originalPath, proposedPath },
                (message) => this.show(ui.showWarningMessage(message)),
              ),
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
    this.show(this.options.ui.showErrorMessage(message));
  }

  /** Fire-and-forget, as the voided promise was: the dialog waits for the
   *  user, its caller does not. One that cannot show leaves a console trace
   *  instead of an unhandled rejection. */
  private show(dialog: Effect.Effect<void, HostFailed>): void {
    this.options.spawn(
      dialog.pipe(
        // The handler's parameter names the channel's whole error type, so a
        // second tag added here fails to compile instead of being dropped.
        Effect.catch((failure: HostFailed) =>
          Effect.logError(
            `Tool-edit notice could not be shown: ${failure.message}`,
          ).pipe(withLogChannel('desktop')),
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
  /** Tell the user something without waiting for them to read it. */
  private readonly warn: (message: string) => void;
  constructor(
    ui: DesktopToolEditApprovalUi,
    request: ToolEditPreviewRequest,
    staged: DesktopStagedFiles,
    warn: (message: string) => void,
  ) {
    this.ui = ui;
    this.request = request;
    this.staged = staged;
    this.warn = warn;
  }

  get originalPath(): string {
    return this.staged.originalPath;
  }

  get proposedPath(): string {
    return this.staged.proposedPath;
  }

  showDiff(): Effect.Effect<void, HostCommandFailure> {
    return this.ui
      .openDiff(
        { filePath: this.staged.originalPath },
        { filePath: this.staged.proposedPath },
        toolEditDiffLabel(this.request),
        this.request.requestId,
      )
      .pipe(
        Effect.mapError((cause) => hostFailure('approval.openDiff', cause)),
      );
  }

  openProposed(): Effect.Effect<void, HostCommandFailure> {
    return this.ui.openPath(this.staged.proposedPath);
  }

  readProposedContent(): Effect.Effect<
    string,
    HostCommandFailure,
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
   * another diff takes only its own off the Review workbench. `unapplied` is
   * the proposed copy as the user's editor saved it: that file stays where
   * the editor has it open, and only the original beside it goes.
   */
  dispose(
    unapplied?: string,
  ): Effect.Effect<void, HostCommandFailure, FileSystem.FileSystem> {
    const { tempDir, originalPath, proposedPath } = this.staged;
    return Effect.suspend(() => {
      if (unapplied !== undefined)
        this.warn(
          UNAPPLIED_TOOL_EDIT.inFile(this.request.relativePath, proposedPath),
        );
      return this.ui.closeDiff(this.request.requestId).pipe(
        Effect.andThen(
          FileSystem.FileSystem.use((fs) =>
            unapplied === undefined
              ? fs.remove(tempDir, { recursive: true, force: true })
              : fs.remove(originalPath, { force: true }),
          ),
        ),
        Effect.mapError((cause) =>
          hostFailure('approval.removeTempDir', cause),
        ),
      );
    });
  }
}
