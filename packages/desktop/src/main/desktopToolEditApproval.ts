/**
 * Desktop preview port for {@link ToolEditApprovalController}.
 *
 * Each request gets its own temp directory; the renderer opens the staged
 * copies through the window's diff and file viewers, and the user's edits are
 * read back from the proposed copy on disk.
 */

import { readFile, rm } from 'node:fs/promises';

import type {
  ToolEditApprovalHost,
  ToolEditPreview,
  ToolEditPreviewContext,
} from '@controllers/approval/ToolEditApprovalController';
import type { DiffSource } from '@hosts/uiHosts';
import { effectRuntime } from '@platform/processRuntime';
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
  ): Promise<void>;
  /**
   * Take this request's staged diff off the Review workbench and nothing
   * else: settling here must not dismiss another request's pending preview
   * or an unrelated review, whichever of them the user is looking at.
   */
  closeDiff(previewId: string): Promise<void>;
};

interface DesktopToolEditApprovalHostOptions {
  ui: DesktopToolEditApprovalUi;
  /** The window's `request.decide`: where a staged request's decision goes. */
  decide: ToolEditApprovalHost['decide'];
}

export class DesktopToolEditApprovalHost implements ToolEditApprovalHost {
  constructor(private readonly options: DesktopToolEditApprovalHostOptions) {}

  get openBuildDisplay(): BuildDisplayFn {
    return this.options.ui.openBuildDisplay;
  }

  get decide(): ToolEditApprovalHost['decide'] {
    return this.options.decide;
  }

  async stagePreview(
    request: ToolEditApprovalRequest,
    context: ToolEditPreviewContext,
  ): Promise<ToolEditPreview> {
    const tempDir = await createTexraTempDir('texra-tool-edit-');
    const { originalPath, proposedPath } = await effectRuntime().runPromise(
      writeApprovalTempFiles({
        directory: tempDir,
        targetPath: request.path,
        originalContent: request.originalContent,
        proposedContent: request.proposedContent,
      }),
    );
    return new DesktopToolEditPreview(this.options.ui, context, {
      tempDir,
      originalPath,
      proposedPath,
    });
  }

  /**
   * Active-stream selection surfaces the prompt in whichever view is open, so nothing has
   * to open ahead of it.
   */
  async revealApprovalSurface(): Promise<void> {}

  reportError(message: string): void {
    void this.options.ui.showErrorMessage(message);
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
   * part of the presentation the controller tracks: returning before it is
   * open would let a release resolve, and the temp directory below go, while
   * the Review tab was still reading the staged files. A failure here
   * propagates to the `present` call the host awaits, which reports it.
   */
  async present(): Promise<void> {
    await this.showDiff();
  }

  async showDiff(): Promise<void> {
    await this.ui.openDiff(
      { filePath: this.staged.originalPath },
      { filePath: this.staged.proposedPath },
      `Tool edit: ${this.context.relativePath}`,
      this.context.requestId,
    );
  }

  async openProposed(): Promise<void> {
    await this.ui.openPath(this.staged.proposedPath);
  }

  async readProposedContent(): Promise<string> {
    return readFile(this.staged.proposedPath, 'utf8');
  }

  /**
   * Close the view before the files behind it go, in that order. The close
   * names this request's preview, so a request settling while the user reads
   * another diff takes only its own off the Review workbench.
   */
  async dispose(): Promise<void> {
    await this.ui.closeDiff(this.context.requestId);
    await rm(this.staged.tempDir, { recursive: true, force: true });
  }
}
