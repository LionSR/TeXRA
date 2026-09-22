/**
 * VS Code preview port for {@link ToolEditApprovalController}.
 *
 * Owns everything the approval flow needs from the editor: the temp files the
 * diff editor reads, the diff tabs themselves, the tab-close listener that
 * turns a closed diff into a rejection, and reading back what the user typed
 * into the proposed side.
 */

import { mkdir } from 'node:fs/promises';

import { Effect } from 'effect';
import * as vscode from 'vscode';

import type { SessionHandle } from '@agent/runtime';
import type {
  ToolEditApprovalHost,
  ToolEditPreview,
  ToolEditPreviewContext,
} from '@controllers/approval/ToolEditApprovalController';
import { fromHost } from '@controllers/session/hostCallFailure';
import {
  tabInputFileUri,
  VscodeDiffViewHost,
  type DiffSession,
} from '@frontend/approval/VscodeDiffViewHost';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import type { ProcessRuntime } from '@platform/processRuntime';
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
  ): Effect.Effect<ToolEditPreview, unknown> {
    return fromHost('stagePreview.mkdir', () =>
      mkdir(this.storageDirectory, { recursive: true }),
    ).pipe(
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
            this.runtime,
          ),
      ),
    );
  }

  revealApprovalSurface(): Effect.Effect<void, unknown> {
    // A failure here reaches the controller's action wrapper, which reports
    // it through `reportError`. Swallowing it left the diff tab open with no
    // approve/reject surface and no visible cause.
    return fromHost('texra.showProgressView', () =>
      vscode.commands.executeCommand('texra.showProgressView'),
    ).pipe(Effect.asVoid);
  }

  reportError(message: string): void {
    // Fire-and-forget, as the voided promise was: the report is logged and
    // shown on its own fiber, and the caller does not wait for the toast.
    this.runtime.runFork(showLoggedMessage(CHANNEL, message));
  }
}

class VscodeToolEditPreview implements ToolEditPreview {
  private readonly diffSession: DiffSession;
  private tabCloseListener: vscode.Disposable | undefined;

  constructor(
    private readonly diffViewHost: VscodeDiffViewHost,
    private readonly request: ToolEditApprovalRequest,
    private readonly context: ToolEditPreviewContext,
    private readonly staged: ApprovalTempFiles,
    private readonly runtime: ProcessRuntime,
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

  present(): Effect.Effect<void, unknown> {
    return this.openDiff().pipe(
      Effect.andThen(Effect.sync(() => this.watchForTabClose())),
      Effect.andThen(
        // A reveal that failed under a request that settled meanwhile is not
        // a presentation failure: the diff opened, and nobody is left to look
        // at the caret.
        this.revealFirstChange().pipe(
          Effect.catch((error) =>
            this.context.isSettled() ? Effect.void : Effect.fail(error),
          ),
        ),
      ),
    );
  }

  showDiff(): Effect.Effect<void, unknown> {
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

  openProposed(): Effect.Effect<void, unknown> {
    return fromHost('showTextDocument', () =>
      vscode.window.showTextDocument(
        vscode.Uri.file(this.staged.proposedPath),
        { preview: true, preserveFocus: true },
      ),
    ).pipe(Effect.asVoid);
  }

  readProposedContent(): Effect.Effect<string, unknown> {
    return this.diffViewHost.readProposedContent(this.diffSession);
  }

  dispose(): Effect.Effect<void, unknown> {
    return Effect.sync(() => {
      // Stop listening for tab closes before closing the diff ourselves.
      this.tabCloseListener?.dispose();
    }).pipe(
      Effect.andThen(this.diffViewHost.closeDiff(this.diffSession)),
      Effect.andThen(this.staged.cleanup),
    );
  }

  private openDiff(): Effect.Effect<void, unknown> {
    return this.diffViewHost.openDiff(
      this.diffSession.original,
      this.diffSession.proposed,
      this.diffSession.title,
    );
  }

  private revealFirstChange(): Effect.Effect<void, unknown> {
    return Effect.suspend(() => {
      const line = firstChangedLine(
        this.request.originalContent,
        this.request.proposedContent,
      );
      if (line === null) return Effect.void;

      return this.diffViewHost.revealFirstChange(this.diffSession, line);
    });
  }

  /**
   * Closing the proposed diff tab (Ctrl+W) rejects the approval. Without this
   * the approval never settles and the agent hangs. The listener is
   * self-cleaning: it disposes once the approval settles, including the
   * programmatic close in {@link dispose}. VS Code hands the close over as a
   * plain callback, so the rejection it raises starts on a fiber of this
   * host's own.
   */
  private watchForTabClose(): void {
    const proposedUri = vscode.Uri.file(this.staged.proposedPath).toString();
    this.tabCloseListener = vscode.window.tabGroups.onDidChangeTabs((event) => {
      if (this.context.isSettled()) {
        this.tabCloseListener?.dispose();
        return;
      }
      const wasClosed = event.closed.some((tab) => {
        return tabInputFileUri(tab)?.toString() === proposedUri;
      });
      if (wasClosed) {
        this.tabCloseListener?.dispose();
        this.runtime.runFork(this.context.discard());
      }
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
