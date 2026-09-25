/**
 * VS Code preview port for {@link ToolEditApprovalController}.
 *
 * Owns everything the approval flow needs from the editor: the temp files the
 * diff editor reads, the diff tabs themselves, and reading back what the
 * user typed into the proposed side. The diff tab is evidence only: closing
 * it leaves the request pending on its card, where Open diff reopens it.
 */

import { Effect, FileSystem } from 'effect';
import * as vscode from 'vscode';

import type { SessionHandle } from '@agent/runtime';
import type {
  ToolEditApprovalHost,
  ToolEditPreview,
  ToolEditPreviewContext,
} from '@controllers/approval/ToolEditApprovalController';
import { fromHost, hostFailure } from '@controllers/session/hostCallFailure';
import {
  VscodeDiffViewHost,
  type DiffSession,
} from '@frontend/approval/VscodeDiffViewHost';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { HostRequestFailure } from '@shared/session/requestErrors';
import type { BuildDisplayFn } from '@tools/approval/latexPreview';
import type { ApprovalTempFiles } from '@tools/approval/tempFileManager';
import { writeApprovalTempFiles } from '@tools/approval/tempFileManager';
import {
  computeLineChangeSummary,
  firstChangedLine,
  type ToolEditApprovalRequest,
} from '@tools/approval/toolEditApproval';
import { pluralize } from '@utils/text/stringUtils';

const CHANNEL = 'ToolEditApproval';

export class VscodeToolEditApprovalHost implements ToolEditApprovalHost {
  private readonly diffViewHost = new VscodeDiffViewHost();
  readonly openBuildDisplay: BuildDisplayFn = (location, options) =>
    Effect.asVoid(openBuildDisplayIfTex(this.session, location, options));

  constructor(
    private readonly storageDirectory: string,
    /** The window's `request.decide`: where a staged request's decision goes. */
    readonly decide: ToolEditApprovalHost['decide'],
    private readonly runtime: ProcessRuntime,
    private readonly session: SessionHandle,
  ) {}

  stagePreview(
    request: ToolEditApprovalRequest,
    context: ToolEditPreviewContext,
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
            context,
            staged,
          ),
      ),
    );
  }

  reportError(message: string): void {
    // Fire-and-forget, as the voided promise was: the report is logged and
    // shown on its own fiber, and the caller does not wait for the toast.
    this.runtime.runFork(showLoggedMessage(CHANNEL, message));
  }
}

class VscodeToolEditPreview implements ToolEditPreview {
  private readonly diffSession: DiffSession;

  constructor(
    private readonly diffViewHost: VscodeDiffViewHost,
    private readonly request: ToolEditApprovalRequest,
    private readonly context: ToolEditPreviewContext,
    private readonly staged: ApprovalTempFiles,
  ) {
    this.diffSession = {
      original: { filePath: staged.originalPath },
      proposed: { filePath: staged.proposedPath },
      title: this.title(),
    };
  }

  get originalPath(): string {
    return this.staged.originalPath;
  }

  get proposedPath(): string {
    return this.staged.proposedPath;
  }

  present(): Effect.Effect<void, HostRequestFailure> {
    return this.openDiff().pipe(Effect.andThen(this.revealFirstChange()));
  }

  showDiff(): Effect.Effect<void, HostRequestFailure> {
    return this.openDiff().pipe(
      Effect.andThen(
        Effect.suspend(() =>
          this.context.isSettled()
            ? this.diffViewHost.closeDiff(this.diffSession)
            : this.revealFirstChange(),
        ),
      ),
    );
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

  dispose(): Effect.Effect<void, HostRequestFailure> {
    return this.diffViewHost.closeDiff(this.diffSession).pipe(
      // The files go whether the tab close succeeds, fails, or is cut off:
      // at window teardown that RPC can reject or outlive the shutdown
      // phase's deadline, and the files would otherwise stay on disk.
      Effect.ensuring(this.staged.cleanup),
    );
  }

  private openDiff(): Effect.Effect<void, HostRequestFailure> {
    return this.diffViewHost.openDiff(
      this.diffSession.original,
      this.diffSession.proposed,
      this.diffSession.title,
    );
  }

  private revealFirstChange(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const line = firstChangedLine(
        this.request.originalContent,
        this.request.proposedContent,
      );
      if (line === null) return Effect.void;

      return this.diffViewHost.revealFirstChange(this.diffSession, line);
    });
  }

  private title(): string {
    const { added, removed } = computeLineChangeSummary(
      this.request.originalContent,
      this.request.proposedContent,
    );
    const changeParts: string[] = [];
    if (added > 0) changeParts.push(`+${added}`);
    if (removed > 0) changeParts.push(`-${removed}`);
    const changeSuffix = changeParts.length
      ? ` · ${changeParts.join(' / ')} ${pluralize(added + removed, 'line')}`
      : '';
    return `Tool edit (${this.request.sourceTool}): ${this.context.relativePath}${changeSuffix}`;
  }
}
