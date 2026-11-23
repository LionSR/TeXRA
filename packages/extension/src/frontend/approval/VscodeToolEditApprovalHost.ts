/**
 * VS Code preview port for {@link ToolEditApprovalController}.
 *
 * Owns everything the approval flow needs from the editor: the temp files the
 * diff editor reads, the diff tabs themselves, and reading back what the
 * user typed into the proposed side, which an approval sends with its
 * decision. The diff tab is evidence only: closing it leaves the request
 * pending on its card, where Open diff reopens it.
 */

import { toolEditDiffLabel } from '@ui/copy/toolEditPreview';
import { Effect, FileSystem } from 'effect';
import * as vscode from 'vscode';

import type { ScopedFork } from '@texra-ai/worldline/host';
import {
  VscodeDiffViewHost,
  type DiffSession,
} from '@frontend/approval/VscodeDiffViewHost';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import type { ShowBuilt } from '@frontend/latex/openBuild';
import {
  fromHost,
  hostFailure,
} from '@texra/controllers/session/hostCallFailure';
import type {
  ToolEditApprovalHost,
  ToolEditPreview,
  ToolEditPreviewRequest,
} from '@texra/controllers/approval/ToolEditApprovalController';
import type { BuildDisplayFn } from '@texra/controllers/approval/latexPreview';
import type { ApprovalTempFiles } from '@texra/controllers/approval/tempFileManager';
import { writeApprovalTempFiles } from '@texra/controllers/approval/tempFileManager';
import { UNAPPLIED_TOOL_EDIT } from '@ui/copy/toolEditPreview';
import { type HostCommandFailure } from '@texra/controllers/session/hostCallFailure';

export class VscodeToolEditApprovalHost implements ToolEditApprovalHost {
  private readonly diffViewHost = new VscodeDiffViewHost();
  readonly openBuildDisplay: BuildDisplayFn;

  private readonly storageDirectory: string;
  private readonly fork: ScopedFork<never>;
  constructor(
    storageDirectory: string,
    /** The view's run function, where a notice is shown. */
    fork: ScopedFork<never>,
    showBuilt: ShowBuilt,
  ) {
    this.storageDirectory = storageDirectory;
    this.fork = fork;
    this.openBuildDisplay = (location, options) =>
      showBuilt([location], options);
  }

  focused(): boolean {
    return vscode.window.state.focused;
  }

  stagePreview(
    request: ToolEditPreviewRequest,
    warn: (message: string) => Effect.Effect<void>,
  ): Effect.Effect<ToolEditPreview, HostCommandFailure, FileSystem.FileSystem> {
    return FileSystem.FileSystem.use((fs) =>
      fs.makeDirectory(this.storageDirectory, { recursive: true }),
    ).pipe(
      Effect.mapError((cause) => hostFailure('stagePreview.mkdir', cause)),
      Effect.andThen(
        writeApprovalTempFiles({
          directory: this.storageDirectory,
          targetPath: request.path,
          originalContent: request.originalContent,
          proposedContent: request.proposedContent,
        }),
      ),
      Effect.map(
        (staged) =>
          new VscodeToolEditPreview(this.diffViewHost, request, staged, warn),
      ),
    );
  }

  notify(level: 'error' | 'warning', message: string): void {
    // Fire-and-forget: the notice is shown on its own fiber, and the caller
    // does not wait for the toast.
    this.fork(vscodeUi.notify(level, message));
  }
}

class VscodeToolEditPreview implements ToolEditPreview {
  private readonly diffSession: DiffSession;

  private readonly diffViewHost: VscodeDiffViewHost;
  private readonly request: ToolEditPreviewRequest;
  private readonly staged: ApprovalTempFiles;
  private readonly warn: (message: string) => Effect.Effect<void>;
  constructor(
    diffViewHost: VscodeDiffViewHost,
    request: ToolEditPreviewRequest,
    staged: ApprovalTempFiles,
    warn: (message: string) => Effect.Effect<void>,
  ) {
    this.diffViewHost = diffViewHost;
    this.request = request;
    this.staged = staged;
    this.warn = warn;
    this.diffSession = {
      original: { filePath: staged.originalPath },
      proposed: { filePath: staged.proposedPath },
      label: toolEditDiffLabel(request),
    };
  }

  get originalPath(): string {
    return this.staged.originalPath;
  }

  get proposedPath(): string {
    return this.staged.proposedPath;
  }

  showDiff(): Effect.Effect<void, HostCommandFailure> {
    return this.openDiff().pipe(Effect.andThen(this.revealFirstChange()));
  }

  openProposed(): Effect.Effect<void, HostCommandFailure> {
    return fromHost('showTextDocument', () =>
      vscode.window.showTextDocument(
        vscode.Uri.file(this.staged.proposedPath),
        { preview: true, preserveFocus: true },
      ),
    ).pipe(Effect.asVoid);
  }

  readProposedContent(): Effect.Effect<
    string,
    HostCommandFailure,
    FileSystem.FileSystem
  > {
    return this.diffViewHost.readProposedContent(this.diffSession);
  }

  /** `unapplied` moves to an untitled editor before the diff closes, where
   *  it outlives the files removed under the diff. If it cannot move, the
   *  diff and its files stay, so the user's text is not lost, and the
   *  failure goes to the caller's report. */
  dispose(unapplied?: string): Effect.Effect<void, HostCommandFailure> {
    const keep =
      unapplied === undefined
        ? Effect.void
        : this.diffViewHost
            .keepProposedText(this.diffSession, unapplied)
            .pipe(
              Effect.andThen(
                this.warn(
                  UNAPPLIED_TOOL_EDIT.inEditor(this.request.relativePath),
                ),
              ),
            );
    return keep.pipe(
      Effect.andThen(
        this.diffViewHost.closeDiff(this.diffSession).pipe(
          // The files go whether the tab close succeeds, fails, or is cut
          // off: at window teardown that RPC can reject or outlive the
          // shutdown phase's deadline, and the files would otherwise stay.
          Effect.ensuring(this.staged.cleanup),
        ),
      ),
    );
  }

  private openDiff(): Effect.Effect<void, HostCommandFailure> {
    return this.diffViewHost.openDiff(
      this.diffSession.original,
      this.diffSession.proposed,
      this.diffSession.label,
    );
  }

  private revealFirstChange(): Effect.Effect<void> {
    const line = this.request.firstChangedLine;
    return line === null
      ? Effect.void
      : this.diffViewHost.revealFirstChange(this.diffSession, line);
  }
}
