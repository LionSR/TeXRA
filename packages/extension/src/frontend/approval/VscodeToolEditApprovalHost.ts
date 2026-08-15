/**
 * VS Code preview port for {@link ToolEditApprovalController}.
 *
 * Owns everything the approval flow needs from the editor: the temp files the
 * diff editor reads, the diff tabs themselves, the tab-close listener that
 * turns a closed diff into a rejection, and reading back what the user typed
 * into the proposed side.
 */

import { promises as fs } from 'node:fs';

import * as vscode from 'vscode';

import type {
  ToolEditApprovalHost,
  ToolEditPreview,
  ToolEditPreviewContext,
} from '@controllers/approval/ToolEditApprovalController';
import {
  tabInputFileUri,
  VscodeDiffViewHost,
} from '@frontend/approval/VscodeDiffViewHost';
import { openBuildDisplayIfTex } from '@frontend/latex/openBuild';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import type { DiffSession, DiffViewHost } from '@hosts/uiHosts';
import type { BuildDisplayFn } from '@tools/approval/latexPreview';
import type { ApprovalTempFiles } from '@tools/approval/tempFileManager';
import { writeApprovalTempFiles } from '@tools/approval/tempFileManager';
import {
  computeLineChangeSummary,
  firstChangedLine,
  type ToolEditApprovalRequest,
} from '@tools/approval/toolEditApproval';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { pluralize } from '@utils/text/stringUtils';

const CHANNEL = 'ToolEditApproval';

export class VscodeToolEditApprovalHost implements ToolEditApprovalHost {
  private readonly diffViewHost: DiffViewHost = new VscodeDiffViewHost();
  readonly openBuildDisplay: BuildDisplayFn = async (location, options) => {
    await openBuildDisplayIfTex(location, options);
  };

  constructor(private readonly storageDirectory: string) {}

  async stagePreview(
    request: ToolEditApprovalRequest,
    context: ToolEditPreviewContext,
  ): Promise<ToolEditPreview> {
    await fs.mkdir(this.storageDirectory, { recursive: true });
    const staged = await writeApprovalTempFiles({
      directory: this.storageDirectory,
      targetPath: request.path,
      originalContent: request.originalContent,
      proposedContent: request.proposedContent,
    });
    return new VscodeToolEditPreview(
      this.diffViewHost,
      request,
      context,
      staged,
    );
  }

  relativeDisplayPath(filePath: string): string {
    return vscode.workspace.asRelativePath(WorkspaceFS.fullPath(filePath));
  }

  async revealApprovalSurface(): Promise<void> {
    // Best-effort: don't let a command failure prevent the approval prompt.
    await Promise.resolve(
      vscode.commands.executeCommand('texra.showProgressView'),
    ).catch(() => {});
  }

  reportError(message: string): void {
    void showLoggedMessage(CHANNEL, message);
  }
}

class VscodeToolEditPreview implements ToolEditPreview {
  private diffSession: DiffSession;
  private tabCloseListener: vscode.Disposable | undefined;

  constructor(
    private readonly diffViewHost: DiffViewHost,
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

  async present(): Promise<void> {
    this.diffSession = await this.openDiff();
    this.watchForTabClose();
    try {
      await this.revealFirstChange();
    } catch (error) {
      if (!this.context.isSettled()) throw error;
    }
  }

  async showDiff(): Promise<void> {
    const reopened = await this.openDiff();
    if (this.context.isSettled()) {
      await this.diffViewHost.closeDiff(reopened);
      return;
    }
    this.diffSession = reopened;
    await this.revealFirstChange();
  }

  async openProposed(): Promise<void> {
    await vscode.window.showTextDocument(
      vscode.Uri.file(this.staged.proposedPath),
      { preview: true, preserveFocus: true },
    );
  }

  async readProposedContent(): Promise<string> {
    return this.diffViewHost.readProposedContent(this.diffSession);
  }

  async dispose(): Promise<void> {
    // Stop listening for tab closes before closing the diff ourselves.
    this.tabCloseListener?.dispose();
    await this.diffViewHost.closeDiff(this.diffSession);
    await this.staged.cleanup();
  }

  private openDiff(): Promise<DiffSession> {
    return this.diffViewHost.openDiff(
      this.diffSession.original,
      this.diffSession.proposed,
      this.diffSession.title,
      { preserveFocus: true },
    );
  }

  private async revealFirstChange(): Promise<void> {
    const line = firstChangedLine(
      this.request.originalContent,
      this.request.proposedContent,
    );
    if (line === null) return;

    await this.diffViewHost.revealFirstChange(this.diffSession, line);
  }

  /**
   * Closing the proposed diff tab (Ctrl+W) rejects the approval. Without this
   * the approval never settles and the agent hangs. The listener is
   * self-cleaning: it disposes once the approval settles, including the
   * programmatic close in {@link dispose}.
   */
  private watchForTabClose(): void {
    const proposedUri = vscode.Uri.file(this.staged.proposedPath).toString();
    this.tabCloseListener = vscode.window.tabGroups.onDidChangeTabs((event) => {
      if (this.context.isSettled()) {
        this.tabCloseListener?.dispose();
        return;
      }
      const wasClosed = event.closed.some((tab) => {
        const uri = tabInputFileUri(tab);
        return uri !== null && uri.toString() === proposedUri;
      });
      if (wasClosed) {
        this.tabCloseListener?.dispose();
        this.context.discard();
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
