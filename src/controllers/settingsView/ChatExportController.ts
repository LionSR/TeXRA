/**
 * Chat export orchestration controller.
 *
 * Owns execution loading, export input construction, formatter selection,
 * storage writes, HTML asset staging, and LaTeX compilation. The Settings
 * handler calls this controller and performs only host UI actions (opening
 * a file, showing a message, opening a browser).
 *
 * This module is VS Code-free — all platform wiring lives in the caller.
 */

import { readRuntimeHistoryExecutionRecord } from '@agent/runtime/historyCommands';

// Local imports - commands (VS Code-free modules)
import {
  formatChatAsMarkdown,
  formatChatAsLatex,
  generateExportFilename,
  generateExportFolderName,
  type ChatExportInput,
} from '@commands/history/chatExportFormatter';

export type { ChatExportInput };

// Local imports - LaTeX
import { compileLatex2Pdf } from '@latex/texTools';

// Local imports - schemas
import type { ExecutionId } from '@shared/schemas';

// Local imports - utils
import { StorageFS, pathToLocation } from '@utils/files';

// ============================================================
// Result types
// ============================================================

/** Outcome of loading execution data for export. */
export type ExportInputStatus =
  | 'ok'
  | 'config_missing'
  | 'conversation_missing';

export type ExportInputResult =
  | { readonly status: 'ok'; readonly exportInput: ChatExportInput }
  | { readonly status: Exclude<ExportInputStatus, 'ok'> };

export interface ChatExportResult {
  /** Storage-relative path to the exported file. */
  readonly storagePath: string;
  /** Absolute filesystem path to the exported file. */
  readonly absolutePath: string;
}

export interface LatexExportResult extends ChatExportResult {
  /** Absolute path to the compiled PDF, or undefined if compilation failed. */
  readonly pdfPath?: string;
}

export interface HtmlExportResult extends ChatExportResult {
  /** Folder name relative to the execution storage. */
  readonly folderName: string;
}

// ============================================================
// Controller
// ============================================================

export class ChatExportController {
  /**
   * Load execution data and construct the format-agnostic {@link ChatExportInput}.
   *
   * Returns a discriminated status so the caller can show the right error
   * message for each missing piece without coupling to storage details.
   */
  async buildExportInput(historyId: string): Promise<ExportInputResult> {
    const record = await readRuntimeHistoryExecutionRecord(
      historyId as ExecutionId,
    );

    if (!record.config) {
      return { status: 'config_missing' };
    }

    if (!record.conversation) {
      return { status: 'conversation_missing' };
    }

    const { config } = record;

    const exportInput: ChatExportInput = {
      timestamp: record.meta?.timestamp ?? new Date().toISOString(),
      description: record.meta?.description,
      config: {
        agent: config.agent,
        model: config.model,
        instruction: config.instruction,
        inputFiles: config.inputFiles,
        mediaFiles: config.mediaFiles,
        contextFiles: config.contextFiles,
        outputFiles: config.outputFiles,
      },
      messages: record.conversation,
    };

    return { status: 'ok', exportInput };
  }

  /**
   * Format and write a Markdown export.
   */
  async exportAsMarkdown(
    historyId: string,
    exportInput: ChatExportInput,
  ): Promise<ChatExportResult> {
    const filename = generateExportFilename(exportInput, 'md');
    const storagePath = `executions/${historyId}/${filename}`;
    const content = formatChatAsMarkdown(exportInput);
    await StorageFS.write(storagePath, content);
    return { storagePath, absolutePath: StorageFS.fullPath(storagePath) };
  }

  /**
   * Format, write, and compile a LaTeX export.
   *
   * Stores the `.tex` source and runs `pdflatex` / `latexmk` on it.
   * Returns the compiled PDF path when compilation succeeds so the caller
   * can decide whether to open the PDF or fall back to the `.tex` source.
   */
  async exportAsLatex(
    historyId: string,
    exportInput: ChatExportInput,
  ): Promise<LatexExportResult> {
    const filename = generateExportFilename(exportInput, 'tex');
    const storagePath = `executions/${historyId}/${filename}`;
    const content = formatChatAsLatex(exportInput);
    await StorageFS.write(storagePath, content);

    const absolutePath = StorageFS.fullPath(storagePath);
    const location = pathToLocation(absolutePath);
    const compiled = await compileLatex2Pdf(location);

    const pdfPath = compiled
      ? absolutePath.replace(/\.tex$/, '.pdf')
      : undefined;

    return { storagePath, absolutePath, pdfPath };
  }

  /**
   * Format and write a self-contained HTML export.
   *
   * Stages third-party assets (KaTeX CSS, highlight.js themes) from
   * `assetsSrc` next to the generated `index.html` so the exported page
   * is fully self-contained and opens correctly in any browser.
   */
  async exportAsHtml(
    historyId: string,
    exportInput: ChatExportInput,
    assetsSrc: string,
  ): Promise<HtmlExportResult> {
    const { formatChatAsHtml } =
      await import('@commands/history/htmlExport/htmlFormatter');
    const fsExtra = (await import('fs-extra')).default;

    const folderName = generateExportFolderName(exportInput);
    const folderPath = `executions/${historyId}/${folderName}`;
    const assetsPath = `${folderPath}/assets`;

    if (!(await fsExtra.pathExists(assetsSrc))) {
      throw new Error(
        `HTML export assets missing at ${assetsSrc} — rebuild the extension ` +
          `(npm run package:fast) so scripts/copy-html-export-assets.mjs runs.`,
      );
    }

    await StorageFS.ensureDir(folderPath);
    await fsExtra.copy(assetsSrc, StorageFS.fullPath(assetsPath), {
      overwrite: true,
    });

    const html = formatChatAsHtml(exportInput);
    const indexPath = `${folderPath}/index.html`;
    await StorageFS.write(indexPath, html);

    return {
      storagePath: indexPath,
      absolutePath: StorageFS.fullPath(indexPath),
      folderName,
    };
  }
}
