/**
 * Chat export orchestration controller.
 *
 * Owns execution loading, export input construction, formatter selection,
 * storage writes, HTML asset staging, and LaTeX compilation. The Settings
 * handler calls this controller and performs only host UI actions (opening
 * a file, showing a message, opening a browser).
 *
 * This module is VS Code-free — all platform wiring lives in the caller. The
 * LaTeX document preamble is a host-supplied asset (the `.tex` template lives
 * under the extension's `resources/`), so the host injects it via the
 * constructor instead of the controller importing `@resources`.
 */

// Local imports
import { loadChatExportInput } from '@agent/export/loadChatExportInput';
import {
  formatChatAsMarkdown,
  formatChatAsLatex,
  generateExportFilename,
  type ChatExportInput,
} from '@agent/export/chatExportFormatter';

export type { ChatExportInput };

import { compileLatex2Pdf } from '@latex/texTools';
import { projectWorkflowCallEntries } from '@model/projectWorkflowCallEntry';
import type { ExecutionId } from '@shared/schemas';
import {
  assembleTrace,
  injectStandaloneTrace,
  type AssembleTraceResult,
} from '@transcript';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { pathToLocation } from '@utils/files/fileLocation';
import { StorageFS } from '@utils/files/storageFS';

// ============================================================
// Result types
// ============================================================

/** Outcome of loading execution data for export. */
type ExportInputStatus = 'ok' | 'config_missing' | 'conversation_missing';

type ExportInputResult =
  | { readonly status: 'ok'; readonly exportInput: ChatExportInput }
  | { readonly status: Exclude<ExportInputStatus, 'ok'> };

interface ChatExportResult {
  /** Storage-relative path to the exported file. */
  readonly storagePath: string;
  /** Absolute filesystem path to the exported file. */
  readonly absolutePath: string;
}

export interface LatexExportResult extends ChatExportResult {
  /** Absolute path to the compiled PDF, or undefined if compilation failed. */
  readonly pdfPath?: string;
  /** Tail of the LaTeX compile log, present when compilation failed. */
  readonly logTail?: string;
}

/** `assembleTrace`'s failure statuses, re-surfaced for the HTML export path. */
type HtmlExportStatus = Exclude<AssembleTraceResult['status'], 'ok'>;

export type HtmlExportOutcome =
  | { readonly status: 'ok'; readonly result: ChatExportResult }
  | { readonly status: HtmlExportStatus };

// ============================================================
// Controller
// ============================================================

interface ChatExportControllerDeps {
  /**
   * LaTeX document preamble prepended to `.tex` exports. Host-supplied because
   * the template lives under the extension's `resources/` tree.
   */
  readonly latexPreamble: string;
}

export class ChatExportController {
  constructor(private readonly deps: ChatExportControllerDeps) {}

  /**
   * Load execution data and construct the format-agnostic {@link ChatExportInput}.
   *
   * Returns a discriminated status so the caller can show the right error
   * message for each missing piece without coupling to storage details.
   * Thin wrapper around the shared {@link loadChatExportInput} loader, which
   * also backs the CLI's `readCliHistoryExportInput` — so both hosts read,
   * validate, and assemble export input identically (including treating a
   * stored-but-empty conversation array as absent, not present).
   */
  async buildExportInput(historyId: string): Promise<ExportInputResult> {
    const { config, exportInput } = await loadChatExportInput(
      historyId as ExecutionId,
    );

    if (!config) {
      return { status: 'config_missing' };
    }

    if (!exportInput) {
      return { status: 'conversation_missing' };
    }

    return { status: 'ok', exportInput };
  }

  /**
   * Format and write a Markdown export.
   */
  async exportAsMarkdown(
    historyId: string,
    exportInput: ChatExportInput,
  ): Promise<ChatExportResult> {
    return this.writeExport(
      historyId,
      generateExportFilename(exportInput, 'md'),
      formatChatAsMarkdown(exportInput),
    );
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
    const { storagePath, absolutePath } = await this.writeExport(
      historyId,
      generateExportFilename(exportInput, 'tex'),
      formatChatAsLatex(exportInput, this.deps.latexPreamble),
    );

    const location = pathToLocation(absolutePath);
    const compiled = await compileLatex2Pdf(location);

    const pdfPath = compiled.ok
      ? absolutePath.replace(/\.tex$/, '.pdf')
      : undefined;

    return {
      storagePath,
      absolutePath,
      pdfPath,
      logTail: compiled.ok ? undefined : compiled.logTail,
    };
  }

  /**
   * Assemble the execution's trace and embed it into the trace-viewer's
   * single-file standalone bundle — the same faithful Progress View replay
   * the CLI's `--export html` produces, not the retired hand-written
   * chat-bubble exporter. Single file, no separate `assets/` folder: it
   * opens correctly straight from disk (`file://`) with no server, which
   * matters here because `vscode.env.openExternal` hands the result to the
   * OS's default handler for the file, not a served URL.
   */
  async exportAsHtml(
    historyId: string,
    standaloneTemplatePath: string,
  ): Promise<HtmlExportOutcome> {
    const traceResult = await assembleTrace(historyId as ExecutionId);
    if (traceResult.status !== 'ok') {
      return { status: traceResult.status };
    }
    const { trace } = traceResult;

    const exportTrace = {
      ...trace,
      entries: projectWorkflowCallEntries(trace.entries),
    };

    if (!(await AbsoluteFS.exists(standaloneTemplatePath))) {
      throw new Error(
        `Trace-viewer standalone bundle missing at ${standaloneTemplatePath} — ` +
          'rebuild the extension (npm run package:fast) so packages/trace-viewer builds.',
      );
    }
    const template = await AbsoluteFS.read(standaloneTemplatePath);
    const html = injectStandaloneTrace(template, exportTrace);

    const filename = generateExportFilename(
      {
        timestamp: trace.meta?.timestamp ?? new Date().toISOString(),
        config: trace.config,
      },
      'html',
    );
    return {
      status: 'ok',
      result: await this.writeExport(historyId, filename, html),
    };
  }

  /** Write an export payload into the execution's storage directory. */
  private async writeExport(
    historyId: string,
    filename: string,
    content: string,
  ): Promise<ChatExportResult> {
    const storagePath = `executions/${historyId}/${filename}`;
    await StorageFS.write(storagePath, content);
    return { storagePath, absolutePath: StorageFS.fullPath(storagePath) };
  }
}
