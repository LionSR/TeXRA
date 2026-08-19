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
import type { BuildDisplayFn } from '@tools/approval/latexPreview';
import { writeApprovalTempFiles } from '@tools/approval/tempFileManager';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
import { createTexraTempDir } from '@utils/files/tempDir';
import { toErrorMessage } from '@utils/errors/errorMessage';

import type { DesktopAgentExecutionHost } from './desktopAgentExecutionHost.js';

type DesktopToolEditApprovalUi = Pick<
  DesktopAgentExecutionHost,
  'openPath' | 'openBuildDisplay' | 'openDiff' | 'showErrorMessage'
>;

interface DesktopToolEditApprovalHostOptions {
  ui: DesktopToolEditApprovalUi;
  /** Parent directory for per-request temp directories; defaults to the OS temp dir. */
  tempRoot?: string;
}

export class DesktopToolEditApprovalHost implements ToolEditApprovalHost {
  constructor(private readonly options: DesktopToolEditApprovalHostOptions) {}

  get openBuildDisplay(): BuildDisplayFn {
    return this.options.ui.openBuildDisplay;
  }

  async stagePreview(
    request: ToolEditApprovalRequest,
    context: ToolEditPreviewContext,
  ): Promise<ToolEditPreview> {
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

  /** The prompt carries the request on its own, so the diff opens alongside it. */
  async present(): Promise<void> {
    void this.showDiff().catch((error: unknown) => {
      if (this.context.isSettled()) return;
      void this.ui.showErrorMessage(toErrorMessage(error));
    });
  }

  async showDiff(): Promise<void> {
    await this.ui.openDiff(
      { filePath: this.staged.originalPath },
      { filePath: this.staged.proposedPath },
      `Tool edit: ${this.context.relativePath}`,
    );
  }

  async openProposed(): Promise<void> {
    await this.ui.openPath(this.staged.proposedPath);
  }

  async readProposedContent(): Promise<string> {
    return readFile(this.staged.proposedPath, 'utf8');
  }

  async dispose(): Promise<void> {
    await rm(this.staged.tempDir, { recursive: true, force: true });
  }
}
