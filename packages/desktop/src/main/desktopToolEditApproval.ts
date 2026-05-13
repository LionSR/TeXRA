import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isLatexFile } from '@common/files/fileTypeUtils';
import { bus } from '@eventBus/ProgressEventBus';
import type { DiffViewHost } from '@hosts/diffViewHost';
import type { BuildDisplayFn } from '@tools/approval/latexPreview';
import {
  previewProposedLatex,
  runLatexdiff,
  type LatexPreviewEntry,
} from '@tools/approval/latexPreview';
import {
  computeLineChangeSummary,
  computeUserPatch,
  isApprovalBypassedForStream,
  registerPendingApproval,
  setToolEditApprovalHandler,
  unregisterPendingApproval,
  type ToolEditApprovalAction,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';
import { WorkspaceFS } from '@utils/files';

export interface DesktopToolEditApprovalOptions {
  openPath?: (filePath: string) => Promise<void>;
  openBuildDisplay?: BuildDisplayFn;
  openDiff?: DiffViewHost['openDiff'];
  showErrorMessage?: (message: string) => Promise<void> | void;
  tempRoot?: string;
}

export interface DesktopToolEditApprovalController {
  handleAction(payload: {
    requestId: string;
    action: ToolEditApprovalAction;
    feedback?: string;
  }): boolean;
  dispose(): void;
}

interface DesktopPendingToolEditApproval extends LatexPreviewEntry {
  requestId: string;
  request: ToolEditApprovalRequest;
  tempDir: string;
  originalUri: { fsPath: string };
  proposedUri: { fsPath: string };
  originalContent: string;
  proposedContent: string;
  settle: (result: ToolEditApprovalResult) => void;
}

class DesktopToolEditApprovalControllerImpl implements DesktopToolEditApprovalController {
  private readonly pending = new Map<string, DesktopPendingToolEditApproval>();
  private disposed = false;

  constructor(private readonly options: DesktopToolEditApprovalOptions = {}) {
    setToolEditApprovalHandler((request) => this.requestApproval(request));
  }

  async requestApproval(
    request: ToolEditApprovalRequest,
  ): Promise<ToolEditApprovalResult> {
    if (this.disposed) {
      throw new Error('Desktop tool edit approval controller is disposed.');
    }

    const requestId = `desktop-approval-${randomUUID()}`;
    const lineChanges = computeLineChangeSummary(
      request.originalContent,
      request.proposedContent,
    );
    const entry = await this.createPendingEntry(requestId, request);
    let settled = false;

    const result = await new Promise<ToolEditApprovalResult>((resolve) => {
      entry.settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      entry.isSettled = () => settled;
      this.pending.set(requestId, entry);
      registerPendingApproval(requestId, {
        streamId: request.streamId,
        isSettled: () => settled,
        settle: (value) => this.settle(requestId, value),
      });
      this.showProgressPermission(requestId, request, lineChanges);
    });

    if (result.accepted && result.appliedContent != null) return result;
    return { ...result, lineChanges: result.lineChanges ?? lineChanges };
  }

  handleAction(payload: {
    requestId: string;
    action: ToolEditApprovalAction;
    feedback?: string;
  }): boolean {
    const entry = this.pending.get(payload.requestId);
    if (!entry || entry.isSettled()) return true;

    switch (payload.action) {
      case 'approve':
        this.runAction(payload.requestId, () =>
          this.approveProposedEdit(payload.requestId, entry),
        );
        return true;
      case 'reject':
        this.settle(payload.requestId, {
          accepted: false,
          userMessage: payload.feedback?.trim() || undefined,
        });
        return true;
      case 'openDiff':
        this.runAction(payload.requestId, () => this.openDiffPatch(entry));
        return true;
      case 'previewProposed':
        this.runAction(payload.requestId, () => this.previewProposed(entry));
        return true;
      case 'showLatexdiff':
        this.runAction(payload.requestId, () =>
          runLatexdiff(entry, {
            subtype: 'ONLYCHANGEDPAGE',
            openBuildDisplay: this.options.openBuildDisplay,
          }),
        );
        return true;
      default:
        return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    setToolEditApprovalHandler();
    for (const requestId of [...this.pending.keys()]) {
      this.settle(requestId, { accepted: false });
    }
  }

  private async createPendingEntry(
    requestId: string,
    request: ToolEditApprovalRequest,
  ): Promise<DesktopPendingToolEditApproval> {
    const tempRoot = this.options.tempRoot ?? tmpdir();
    const tempDir = await mkdtemp(path.join(tempRoot, 'texra-tool-edit-'));
    const ext = path.extname(request.path) || '.txt';
    const originalPath = path.join(tempDir, `${randomUUID()}-original${ext}`);
    const proposedPath = path.join(tempDir, `${randomUUID()}-proposed${ext}`);
    await Promise.all([
      writeFile(originalPath, request.originalContent, 'utf8'),
      writeFile(proposedPath, request.proposedContent, 'utf8'),
    ]);

    return {
      requestId,
      request,
      tempDir,
      originalUri: { fsPath: originalPath },
      proposedUri: { fsPath: proposedPath },
      originalContent: request.originalContent,
      proposedContent: request.proposedContent,
      isSettled: () => false,
      settle: () => {},
      workspaceTempCleanup: [],
      latexOperationInProgress: false,
      onError: (message) => this.report(message),
    };
  }

  private showProgressPermission(
    requestId: string,
    request: ToolEditApprovalRequest,
    lineChanges: { added: number; removed: number },
  ): void {
    if (request.streamId) {
      bus.emit('setActiveStream', { streamId: request.streamId });
    }

    const isBypassed = request.streamId
      ? isApprovalBypassedForStream(request.streamId)
      : false;
    bus.emit('showToolEditPermission', {
      requestId,
      path: request.path,
      relativePath: this.relativeDisplayPath(request.path),
      sourceTool: request.sourceTool,
      allowBypass: !isBypassed,
      streamId: request.streamId ?? '',
      addedLines: lineChanges.added,
      removedLines: lineChanges.removed,
      isLatex: isLatexFile(request.path),
    });
  }

  private relativeDisplayPath(filePath: string): string {
    try {
      return WorkspaceFS.relativePath(filePath);
    } catch {
      return path.basename(filePath);
    }
  }

  private settle(requestId: string, result: ToolEditApprovalResult): void {
    const entry = this.pending.get(requestId);
    if (!entry || entry.isSettled()) return;

    this.pending.delete(requestId);
    unregisterPendingApproval(requestId);
    entry.settle(result);
    bus.emit('resolveToolEditPermission', { requestId });
    this.cleanupEntry(entry);
  }

  private runAction(requestId: string, action: () => Promise<void>): void {
    void action().catch((error) => {
      if (this.pending.has(requestId)) {
        this.report(error instanceof Error ? error.message : String(error));
      }
    });
  }

  private async previewProposed(
    entry: DesktopPendingToolEditApproval,
  ): Promise<void> {
    const openBuildDisplay = this.options.openBuildDisplay;
    if (isLatexFile(entry.request.path) && openBuildDisplay) {
      await previewProposedLatex(entry, { openBuildDisplay });
      return;
    }

    if (!this.options.openPath) {
      await this.report('Desktop preview is unavailable.');
      return;
    }

    await this.options.openPath(entry.proposedUri.fsPath);
  }

  private async approveProposedEdit(
    requestId: string,
    entry: DesktopPendingToolEditApproval,
  ): Promise<void> {
    const appliedContent = await readFile(entry.proposedUri.fsPath, 'utf8');
    this.settle(requestId, { accepted: true, appliedContent });
  }

  private async openDiffPatch(
    entry: DesktopPendingToolEditApproval,
  ): Promise<void> {
    if (this.options.openDiff) {
      await this.options.openDiff(
        { filePath: entry.originalUri.fsPath },
        { filePath: entry.proposedUri.fsPath },
        `Tool edit: ${path.basename(entry.request.path)}`,
        { preserveFocus: true },
      );
      return;
    }

    if (!this.options.openPath) {
      await this.report('Desktop diff preview is unavailable.');
      return;
    }

    const patch =
      computeUserPatch(entry.originalContent, entry.proposedContent) ??
      `No textual changes for ${entry.request.path}.\n`;
    const diffPath = path.join(entry.tempDir, `${randomUUID()}-changes.diff`);
    await writeFile(diffPath, patch, 'utf8');
    entry.workspaceTempCleanup.push(() => rm(diffPath, { force: true }));
    await this.options.openPath(diffPath);
  }

  private cleanupEntry(entry: DesktopPendingToolEditApproval): void {
    void Promise.all([
      ...entry.workspaceTempCleanup.map((cleanup) =>
        cleanup().catch(() => undefined),
      ),
      rm(entry.tempDir, { recursive: true, force: true }),
    ]);
  }

  private async report(message: string): Promise<void> {
    await this.options.showErrorMessage?.(message);
  }
}

export function createDesktopToolEditApprovalController(
  options: DesktopToolEditApprovalOptions = {},
): DesktopToolEditApprovalController {
  return new DesktopToolEditApprovalControllerImpl(options);
}
