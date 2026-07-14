import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { nanoid } from 'nanoid';

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  matchesCancelSelector,
  type HostInteractionCancelSelector,
  type HostInteractionOptions,
} from '@agent/runtime/HostInteractions';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { isLatexFile } from '@common/files/fileTypeUtils';
import type { DiffViewHost } from '@hosts/uiHosts';
import type { StreamTabId } from '@shared/schemas';
import type { ToolEditApprovalAction } from '@shared/schemas/prompts';
import type { BuildDisplayFn } from '@tools/approval/latexPreview';
import {
  previewProposedLatex,
  runLatexdiff,
  type LatexPreviewEntry,
} from '@tools/approval/latexPreview';
import { writeApprovalTempFiles } from '@tools/approval/tempFileManager';
import {
  computeLineChangeSummary,
  computeUserPatch,
  emitToolEditApprovalPrompt,
  registerPendingApproval,
  unregisterPendingApproval,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';
import { WorkspaceFS } from '@utils/files';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { normalizeLineEndings } from '@utils/text/stringUtils';
import { createTexraTempDir } from './desktopTempDir.js';

export interface DesktopToolEditApprovalOptions {
  runtimeHost: AgentRuntimeHost;
  session: SessionHandle;
  openPath?: (filePath: string) => Promise<void>;
  openBuildDisplay?: BuildDisplayFn;
  openDiff?: DiffViewHost['openDiff'];
  showErrorMessage?: (message: string) => Promise<void> | void;
  tempRoot?: string;
}

export interface DesktopToolEditApprovalController {
  approvePendingForStream(streamId: StreamTabId): Promise<void>;
  cancel(selector?: HostInteractionCancelSelector): void;
  handleAction(payload: {
    requestId: string;
    action: ToolEditApprovalAction;
    feedback?: string;
  }): boolean;
  requestApproval(
    request: ToolEditApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<ToolEditApprovalResult>;
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
  cancellationScope?: object;
}

interface InitializingToolEditApproval {
  readonly request: ToolEditApprovalRequest;
  readonly cancellationScope?: object;
  earlyResolution?: ToolEditApprovalResult;
}

class DesktopToolEditApprovalControllerImpl implements DesktopToolEditApprovalController {
  private readonly initializing = new Map<
    string,
    InitializingToolEditApproval
  >();
  private readonly pending = new Map<string, DesktopPendingToolEditApproval>();
  private disposed = false;

  constructor(private readonly options: DesktopToolEditApprovalOptions) {}

  async requestApproval(
    request: ToolEditApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<ToolEditApprovalResult> {
    if (this.disposed) {
      throw new Error('Desktop tool edit approval controller is disposed.');
    }

    const requestId = `desktop-approval-${nanoid()}`;
    const lineChanges = computeLineChangeSummary(
      request.originalContent,
      request.proposedContent,
    );
    const initialization: InitializingToolEditApproval = {
      request,
      cancellationScope: options?.cancellationScope,
    };
    this.initializing.set(requestId, initialization);
    let entry: DesktopPendingToolEditApproval;
    try {
      entry = await this.createPendingEntry(requestId, request);
    } catch (error) {
      this.initializing.delete(requestId);
      throw error;
    }
    this.initializing.delete(requestId);
    if (initialization.earlyResolution) {
      this.cleanupEntry(entry);
      return {
        ...initialization.earlyResolution,
        lineChanges: initialization.earlyResolution.lineChanges ?? lineChanges,
      };
    }
    entry.cancellationScope = initialization.cancellationScope;
    let settled = false;

    const result = await new Promise<ToolEditApprovalResult>((resolve) => {
      entry.settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      entry.isSettled = () => settled;
      this.pending.set(requestId, entry);
      registerPendingApproval(
        requestId,
        {
          // `streamId` is `.nullish()` on the tool schema (string | null |
          // undefined); the approval registry expects `string | undefined`, so
          // collapse null → undefined (matches nativeToolEditApproval).
          streamId: request.streamId ?? undefined,
          isSettled: () => settled,
          settle: (value) => this.settle(requestId, value),
        },
        this.options.session,
      );
      this.showProgressPermission(
        this.options.session,
        requestId,
        request,
        lineChanges,
      );
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
        void this.runAction(payload.requestId, () =>
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
        void this.runAction(payload.requestId, () => this.openDiffPatch(entry));
        return true;
      case 'previewProposed':
        void this.runAction(payload.requestId, () =>
          this.previewProposed(entry),
        );
        return true;
      case 'showLatexdiff':
        void this.runAction(payload.requestId, () =>
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

  async approvePendingForStream(streamId: StreamTabId): Promise<void> {
    for (const initialization of this.initializing.values()) {
      if (
        initialization.earlyResolution ||
        initialization.request.streamId !== streamId
      ) {
        continue;
      }
      initialization.earlyResolution = {
        accepted: true,
        appliedContent: initialization.request.proposedContent,
      };
    }
    const pending = [...this.pending].filter(
      ([, entry]) => entry.request.streamId === streamId && !entry.isSettled(),
    );
    await Promise.all(
      pending.map(([requestId, entry]) =>
        this.runAction(requestId, () =>
          this.approveProposedEdit(requestId, entry),
        ),
      ),
    );
  }

  cancel(selector: HostInteractionCancelSelector = {}): void {
    for (const initialization of this.initializing.values()) {
      if (
        initialization.earlyResolution ||
        !matchesCancelSelector(
          {
            kind: 'toolEdit',
            streamId: initialization.request.streamId ?? undefined,
            cancellationScope: initialization.cancellationScope,
          },
          selector,
        )
      ) {
        continue;
      }
      initialization.earlyResolution = {
        accepted: false,
        userMessage: selector.cause,
      };
    }
    for (const [requestId, entry] of [...this.pending.entries()]) {
      if (
        !matchesCancelSelector(
          {
            kind: 'toolEdit',
            streamId: entry.request.streamId ?? undefined,
            cancellationScope: entry.cancellationScope,
          },
          selector,
        )
      ) {
        continue;
      }
      this.settle(requestId, {
        accepted: false,
        userMessage: selector.cause,
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel({ cause: 'Desktop session disposed.' });
  }

  private async createPendingEntry(
    requestId: string,
    request: ToolEditApprovalRequest,
  ): Promise<DesktopPendingToolEditApproval> {
    const tempDir = await createTexraTempDir(
      'texra-tool-edit-',
      this.options.tempRoot,
    );
    const { originalPath, proposedPath } = await writeApprovalTempFiles({
      directory: tempDir,
      targetPath: request.path,
      originalContent: request.originalContent,
      proposedContent: request.proposedContent,
    });

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
    session: SessionHandle,
    requestId: string,
    request: ToolEditApprovalRequest,
    lineChanges: { added: number; removed: number },
  ): void {
    // Activate the stream that needs approval and post the prompt (shared with
    // the VS Code host); the desktop host has no workspace API, so it falls
    // back to a basename when computing the relative display path.
    emitToolEditApprovalPrompt(this.options.runtimeHost, session, {
      requestId,
      request,
      relativePath: this.relativeDisplayPath(request.path),
      lineChanges,
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
    unregisterPendingApproval(requestId, this.options.session);
    entry.settle(result);
    this.options.runtimeHost.emit('resolveToolEditPermission', { requestId });
    this.cleanupEntry(entry);
  }

  private async runAction(
    requestId: string,
    action: () => Promise<void>,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (this.pending.has(requestId)) {
        await this.report(toErrorMessage(error));
      }
    }
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
    // Normalize: this read bypasses BaseFS so may contain CRLF.
    const appliedContent = normalizeLineEndings(
      await readFile(entry.proposedUri.fsPath, 'utf8'),
    );
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
    const diffPath = path.join(entry.tempDir, `${nanoid()}-changes.diff`);
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
  options: DesktopToolEditApprovalOptions,
): DesktopToolEditApprovalController {
  return new DesktopToolEditApprovalControllerImpl(options);
}
