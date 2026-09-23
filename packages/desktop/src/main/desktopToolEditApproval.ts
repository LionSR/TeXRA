/**
 * Desktop preview port for {@link ToolEditApprovalController}.
 *
 * Each request gets its own temp directory; the renderer opens the staged
 * copies through the window's diff and file viewers, and the user's edits are
 * read back from the proposed copy on disk.
 */

import { readFile, rm } from 'node:fs/promises';

// Third-party imports
import { Effect } from 'effect';

// Local imports - types
import type {
  ToolEditApprovalHost,
  ToolEditPreview,
  ToolEditPreviewContext,
} from '@controllers/approval/ToolEditApprovalController';
import { fromHost, hostFailure } from '@controllers/session/hostCallFailure';
import { NotificationFailed, type DiffSource } from '@hosts/uiHosts';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { HostRequestFailure } from '@shared/session/requestErrors';
import type { BuildDisplayFn } from '@tools/approval/latexPreview';
import { writeApprovalTempFiles } from '@tools/approval/tempFileManager';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
import { createTexraTempDir } from '@utils/files/tempDir';

import type { DesktopAgentRunHost } from './desktopAgentRunHost.js';

export type DesktopToolEditApprovalUi = Pick<
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
  closeDiff(previewId: string): Effect.Effect<void, Error>;
};

interface DesktopToolEditApprovalHostOptions {
  ui: DesktopToolEditApprovalUi;
  /** The window's `request.decide`: where a staged request's decision goes. */
  decide: ToolEditApprovalHost['decide'];
  /** The process runtime this window's run wiring was handed. */
  runtime: ProcessRuntime;
}

export class DesktopToolEditApprovalHost implements ToolEditApprovalHost {
  constructor(private readonly options: DesktopToolEditApprovalHostOptions) {}

  get openBuildDisplay(): BuildDisplayFn {
    return this.options.ui.openBuildDisplay;
  }

  get decide(): ToolEditApprovalHost['decide'] {
    return this.options.decide;
  }

  stagePreview(
    request: ToolEditApprovalRequest,
    context: ToolEditPreviewContext,
  ): Effect.Effect<ToolEditPreview, HostRequestFailure> {
    const { ui } = this.options;
    return fromHost('approval.createTempDir', () =>
      createTexraTempDir('texra-tool-edit-'),
    ).pipe(
      Effect.flatMap((tempDir) =>
        writeApprovalTempFiles({
          directory: tempDir,
          targetPath: request.path,
          originalContent: request.originalContent,
          proposedContent: request.proposedContent,
        }).pipe(
          Effect.map(
            ({ originalPath, proposedPath }) =>
              new DesktopToolEditPreview(ui, context, {
                tempDir,
                originalPath,
                proposedPath,
              }),
          ),
        ),
      ),
    );
  }

  // No `revealApprovalSurface`: active-stream selection surfaces the prompt
  // in whichever view is open, so nothing has to open ahead of it.

  reportError(message: string): void {
    // Fire-and-forget, as the voided promise was; a dialog that cannot show
    // the report leaves a console trace instead of an unhandled rejection.
    this.options.runtime.runFork(
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
  constructor(
    private readonly ui: DesktopToolEditApprovalUi,
    private readonly context: ToolEditPreviewContext,
    private readonly staged: DesktopStagedFiles,
  ) {}

  get originalPath(): string {
    return this.staged.originalPath;
  }

  get proposedPath(): string {
    return this.staged.proposedPath;
  }

  /**
   * The prompt carries the request on its own, but the diff beside it is
   * part of the presentation the controller tracks: settling before it is
   * open would let a release settle, and the temp directory below go, while
   * the Review tab was still reading the staged files. A failure here
   * reaches the `present` call the host runs, which reports it.
   */
  present(): Effect.Effect<void, HostRequestFailure> {
    return this.showDiff();
  }

  showDiff(): Effect.Effect<void, HostRequestFailure> {
    return this.ui
      .openDiff(
        { filePath: this.staged.originalPath },
        { filePath: this.staged.proposedPath },
        `Tool edit: ${this.context.relativePath}`,
        this.context.requestId,
      )
      .pipe(
        Effect.mapError((cause) => hostFailure('approval.openDiff', cause)),
      );
  }

  openProposed(): Effect.Effect<void, HostRequestFailure> {
    // #12734's Effect-typed `openPath` reaches the controller as the program
    // it is: `ToolEditPreview` is no longer a Promise-shaped core port, so
    // the run this settled on is gone with the face that needed it.
    return this.ui.openPath(this.staged.proposedPath);
  }

  readProposedContent(): Effect.Effect<string, HostRequestFailure> {
    return fromHost('approval.readProposed', () =>
      readFile(this.staged.proposedPath, 'utf8'),
    );
  }

  /**
   * Close the view before the files behind it go, in that order. The close
   * names this request's preview, so a request settling while the user reads
   * another diff takes only its own off the Review workbench.
   */
  dispose(): Effect.Effect<void, HostRequestFailure> {
    return this.ui.closeDiff(this.context.requestId).pipe(
      Effect.mapError((cause) => hostFailure('approval.closeDiff', cause)),
      Effect.andThen(
        fromHost('approval.removeTempDir', () =>
          rm(this.staged.tempDir, { recursive: true, force: true }),
        ),
      ),
    );
  }
}
