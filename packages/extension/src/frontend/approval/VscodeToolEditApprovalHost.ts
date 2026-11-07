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
import { Effect, FileSystem, Scope } from 'effect';
import * as vscode from 'vscode';

import { withLogChannel, type ProcessRuntime } from '@texra-ai/harness/host';
import {
  VscodeDiffViewHost,
  type DiffSession,
} from '@frontend/approval/VscodeDiffViewHost';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { announce, showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import {
  fromHost,
  hostFailure,
} from '@texra/controllers/session/hostCallFailure';
import type {
  ToolEditApprovalHost,
  ToolEditPreview,
  ToolEditPreviewRequest,
} from '@texra/controllers/approval/ToolEditApprovalController';
import type { BuildDisplayFn } from '@texra/tools/latex/latexPreview';
import type { ApprovalTempFiles } from '@texra/tools/approval/tempFileManager';
import { writeApprovalTempFiles } from '@texra/tools/approval/tempFileManager';
import { UNAPPLIED_TOOL_EDIT } from '@ui/copy/toolEditPreview';
import type { WorkspaceRoots } from '@texra-ai/harness';
import { type HostRequestFailure } from '@texra/controllers/session/hostCallFailure';

const CHANNEL = 'ToolEditApproval';

export class VscodeToolEditApprovalHost implements ToolEditApprovalHost {
  private readonly diffViewHost = new VscodeDiffViewHost();
  readonly openBuildDisplay: BuildDisplayFn = (location, options) =>
    openBuildDisplayIfTex(this.roots, location, options).pipe(
      Effect.asVoid,
      Effect.provideService(Scope.Scope, this.scope),
    );

  private readonly storageDirectory: string;
  private readonly runtime: ProcessRuntime;
  private readonly roots: WorkspaceRoots;
  private readonly scope: Scope.Scope;
  constructor(
    storageDirectory: string,
    runtime: ProcessRuntime,
    roots: WorkspaceRoots,
    /** The view's scope, which a scheduled PDF viewer open runs in. */
    scope: Scope.Scope,
  ) {
    this.storageDirectory = storageDirectory;
    this.runtime = runtime;
    this.roots = roots;
    this.scope = scope;
  }

  focused(): boolean {
    return vscode.window.state.focused;
  }

  stagePreview(
    request: ToolEditPreviewRequest,
  ): Effect.Effect<ToolEditPreview, HostRequestFailure, FileSystem.FileSystem> {
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
          new VscodeToolEditPreview(
            this.diffViewHost,
            request,
            staged,
            this.warn,
          ),
      ),
    );
  }

  reportError(message: string): void {
    // Fire-and-forget, as the voided promise was: the report is logged and
    // shown on its own fiber, and the caller does not wait for the toast.
    this.runtime.runFork(showLoggedMessage(CHANNEL, message));
  }

  /** A warning, logged and shown on its own fiber, as a report is. */
  private readonly warn = (message: string): void => {
    this.runtime.runFork(
      Effect.logWarning(message).pipe(
        withLogChannel(CHANNEL),
        Effect.andThen(
          announce(CHANNEL, vscodeUi.showWarningMessage(message), undefined),
        ),
      ),
    );
  };
}

class VscodeToolEditPreview implements ToolEditPreview {
  private readonly diffSession: DiffSession;

  private readonly diffViewHost: VscodeDiffViewHost;
  private readonly request: ToolEditPreviewRequest;
  private readonly staged: ApprovalTempFiles;
  /** Tell the user something without waiting for them to read it. */
  private readonly warn: (message: string) => void;
  constructor(
    diffViewHost: VscodeDiffViewHost,
    request: ToolEditPreviewRequest,
    staged: ApprovalTempFiles,
    warn: (message: string) => void,
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

  showDiff(): Effect.Effect<void, HostRequestFailure> {
    return this.openDiff().pipe(Effect.andThen(this.revealFirstChange()));
  }

  openProposed(): Effect.Effect<void, HostRequestFailure> {
    return fromHost('showTextDocument', () =>
      vscode.window.showTextDocument(
        vscode.Uri.file(this.staged.proposedPath),
        { preview: true, preserveFocus: true },
      ),
    ).pipe(Effect.asVoid);
  }

  readProposedContent(): Effect.Effect<
    string,
    HostRequestFailure,
    FileSystem.FileSystem
  > {
    return this.diffViewHost.readProposedContent(this.diffSession);
  }

  /** `unapplied` moves to an untitled editor before the diff closes, where
   *  it outlives the files removed under the diff. If it cannot move, the
   *  diff and its files stay, so the user's text is not lost, and the
   *  failure goes to the caller's report. */
  dispose(unapplied?: string): Effect.Effect<void, HostRequestFailure> {
    const keep =
      unapplied === undefined
        ? Effect.void
        : this.diffViewHost
            .keepProposedText(this.diffSession, unapplied)
            .pipe(
              Effect.andThen(
                Effect.sync(() =>
                  this.warn(
                    UNAPPLIED_TOOL_EDIT.inEditor(this.request.relativePath),
                  ),
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

  private openDiff(): Effect.Effect<void, HostRequestFailure> {
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
