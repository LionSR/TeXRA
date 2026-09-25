/**
 * Chat export orchestration controller.
 *
 * Owns run loading, export input construction, formatter selection,
 * storage writes, HTML asset staging, and LaTeX compilation. The progress-view
 * toolbar (`EXPORT_TRANSCRIPT`) is the GUI caller; the CLI's
 * `texra history --export` shares the same loaders and formatters. Hosts
 * perform only UI actions (opening a file, showing a message, opening a
 * browser).
 *
 * Not a Settings History leftover: that tab was retired. Do not delete this
 * writer as part of settings-view cleanup.
 *
 * This module is VS Code-free: all platform wiring lives in the caller. The
 * LaTeX document preamble is a host-supplied asset (the `.tex` template lives
 * under the extension's `resources/`), so the host injects it via the
 * constructor instead of the controller importing `@resources`.
 */

import * as path from 'node:path';

import { Effect, FileSystem, type PlatformError } from 'effect';

import {
  loadChatExportInput,
  type ChatExportInputUnreadable,
} from '@agent/export/loadChatExportInput';
import {
  formatChatAsMarkdown,
  formatChatAsLatex,
  generateExportFilename,
} from '@agent/export/chatExportFormatter';
import type { ChatExportInput } from '@agent/export/schemas';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { isNotADirectoryError } from '@common/errors';
import { compileLatex2Pdf } from '@latex/texTools';
import { StorageFs, type WorkspaceFs } from '@platform/rootedFs';
import type { RunId } from '@shared/schemas';
import {
  assembleTrace,
  injectStandaloneTrace,
  type AssembleTraceResult,
} from '@transcript';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { pathToLocationIn } from '@utils/files/fileLocation';
import { normalizeLineEndings } from '@utils/text/stringUtils';

import { TranscriptExportFailed } from './transcriptExportFailure';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

/** Outcome of loading run data for export. */
export type ExportInputStatus =
  'ok' | 'config_missing' | 'conversation_missing';

type ExportInputResult =
  | { readonly status: 'ok'; readonly exportInput: ChatExportInput }
  | { readonly status: Exclude<ExportInputStatus, 'ok'> };

interface ChatExportResult {
  /** Storage-relative path to the exported file. */
  readonly storagePath: string;
  /** Absolute filesystem path to the exported file. */
  readonly absolutePath: string;
}

interface LatexExportResult extends ChatExportResult {
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

/** The host-supplied trace-viewer bundle is unusable. The tag carries the
 *  minted error as its own cause, so a dialog wording `cause` reads exactly
 *  the sentence the bare `Error` carried here before. */
function bundleFailure(
  message: string,
): Effect.Effect<never, TranscriptExportFailed> {
  return Effect.fail(
    new TranscriptExportFailed({
      step: 'traceViewerBundle',
      message,
      cause: new Error(message),
    }),
  );
}

interface ChatExportControllerDeps {
  /**
   * LaTeX document preamble prepended to `.tex` exports. Host-supplied because
   * the template lives under the extension's `resources/` tree.
   */
  readonly latexPreamble: string;
  readonly session: SessionHandle;
}

export class ChatExportController {
  constructor(private readonly deps: ChatExportControllerDeps) {}

  /**
   * Load run data and construct the format-agnostic {@link ChatExportInput}.
   *
   * Returns a discriminated status so the caller can show the right error
   * message for each missing piece without coupling to storage details.
   * Thin wrapper around the shared {@link loadChatExportInput} loader, which
   * also backs the CLI's `readCliHistoryExportInput`: so both hosts read,
   * validate, and assemble export input identically (including treating a
   * stored-but-empty conversation array as absent, not present).
   */
  readonly buildExportInput = Effect.fn(
    'ChatExportController.buildExportInput',
  )(function* (
    this: ChatExportController,
    runId: RunId,
  ): Effect.fn.Return<ExportInputResult, ChatExportInputUnreadable> {
    const { config, exportInput } = yield* loadChatExportInput(
      runId,
      this.deps.session,
    );

    if (!config) {
      return { status: 'config_missing' };
    }

    if (!exportInput) {
      return { status: 'conversation_missing' };
    }

    return { status: 'ok', exportInput };
  });

  /**
   * Format and write a Markdown export.
   */
  readonly exportAsMarkdown = Effect.fn(
    'ChatExportController.exportAsMarkdown',
  )(function* (
    this: ChatExportController,
    runId: RunId,
    exportInput: ChatExportInput,
  ): Effect.fn.Return<
    ChatExportResult,
    PlatformError.PlatformError,
    StorageFs
  > {
    return yield* this.writeExport(
      runId,
      generateExportFilename(exportInput, 'md'),
      formatChatAsMarkdown(exportInput),
    );
  });

  /**
   * Format, write, and compile a LaTeX export.
   *
   * Stores the `.tex` source and runs `pdflatex` / `latexmk` on it.
   * Returns the compiled PDF path when compilation succeeds so the caller
   * can decide whether to open the PDF or fall back to the `.tex` source.
   */
  readonly exportAsLatex = Effect.fn('ChatExportController.exportAsLatex')(
    function* (
      this: ChatExportController,
      runId: RunId,
      exportInput: ChatExportInput,
    ): Effect.fn.Return<
      LatexExportResult,
      PlatformError.PlatformError,
      FileSystem.FileSystem | StorageFs | WorkspaceFs | ChildProcessSpawner
    > {
      const { storagePath, absolutePath } = yield* this.writeExport(
        runId,
        generateExportFilename(exportInput, 'tex'),
        formatChatAsLatex(exportInput, this.deps.latexPreamble),
      );

      const compiled = yield* compileLatex2Pdf(
        pathToLocationIn(this.deps.session.roots.workspace, absolutePath),
        this.deps.session.roots,
      );

      return {
        storagePath,
        absolutePath,
        pdfPath: compiled.ok ? compiled.pdfPath : undefined,
        logTail: compiled.ok ? undefined : compiled.logTail,
      };
    },
  );

  /**
   * Assemble the run's trace and embed it into the trace-viewer's
   * single-file standalone bundle: the same faithful Progress View replay
   * the CLI's `--export html` produces, not the retired hand-written
   * chat-bubble exporter. Single file, no separate `assets/` folder: it
   * opens correctly straight from disk (`file://`) with no server, which
   * matters here because `vscode.env.openExternal` hands the result to the
   * OS's default handler for the file, not a served URL.
   */
  readonly exportAsHtml = Effect.fn('ChatExportController.exportAsHtml')(
    function* (
      this: ChatExportController,
      runId: RunId,
      standaloneTemplatePath: string,
    ): Effect.fn.Return<
      HtmlExportOutcome,
      PlatformError.PlatformError | TranscriptExportFailed,
      FileSystem.FileSystem | StorageFs
    > {
      const traceResult = yield* assembleTrace(runId, this.deps.session).pipe(
        Effect.mapError(
          (cause) =>
            new TranscriptExportFailed({
              step: 'assembleTrace',
              message: toErrorMessage(cause),
              cause,
            }),
        ),
      );
      if (traceResult.status !== 'ok') {
        return { status: traceResult.status };
      }
      const { trace, record } = traceResult;

      // The bundle path is host-supplied and absolute, so it is the process
      // filesystem's, not a rooted view's. Effect's `FileSystem.exists`
      // resolves a relative path against cwd, so require an absolute path
      // here: a relative argument must not silently retarget. A path whose
      // parent is not a directory is a missing bundle, not a failure:
      // `FileSystem.exists` reports ENOTDIR as `BadResource`, and the catch
      // below reads it as absent alongside ENOENT.
      const fs = yield* FileSystem.FileSystem;
      if (!path.isAbsolute(standaloneTemplatePath)) {
        return yield* bundleFailure(
          `Trace-viewer standalone bundle path must be absolute: ${standaloneTemplatePath}`,
        );
      }
      const exists = yield* fs.exists(standaloneTemplatePath).pipe(
        Effect.catchIf(
          (error) =>
            error.reason._tag === 'BadResource' &&
            isNotADirectoryError(error.reason.cause),
          () => Effect.succeed(false),
        ),
      );
      if (!exists) {
        return yield* bundleFailure(
          `Trace-viewer standalone bundle missing at ${standaloneTemplatePath}: ` +
            'rebuild the extension (npm run package:fast) so packages/trace-viewer builds.',
        );
      }
      // The bytes are decoded here rather than by `readFileString`, whose
      // UTF-8 `TextDecoder` would strip a leading BOM, and the line endings
      // are normalized, matching `readNormalizedFile`.
      const bytes = yield* fs.readFile(standaloneTemplatePath);
      const template = normalizeLineEndings(
        Buffer.from(bytes).toString('utf-8'),
      );
      const html = injectStandaloneTrace(template, trace);

      const filename = generateExportFilename(
        {
          // The creation row's publish clock is the run's launch time. Found
          // by type rather than by position: an aggregate always opens with
          // `run.start`, but that ordering is another file's invariant, and
          // the assembler only guarantees the document is non-empty.
          timestamp: new Date(
            (
              trace.events.find((event) => event.type === 'run.start') ??
              trace.events[0]!
            ).at,
          ).toISOString(),
          config: record,
        },
        'html',
      );
      return {
        status: 'ok',
        result: yield* this.writeExport(runId, filename, html),
      };
    },
  );

  /** Write an export payload into the run's storage directory. */
  private readonly writeExport = Effect.fn('ChatExportController.writeExport')(
    function* (
      this: ChatExportController,
      runId: RunId,
      filename: string,
      content: string,
    ): Effect.fn.Return<
      ChatExportResult,
      PlatformError.PlatformError,
      StorageFs
    > {
      const storagePath = `executions/${runId}/${filename}`;
      const storageFs = yield* StorageFs;
      yield* storageFs.makeDirectory(`executions/${runId}`, {
        recursive: true,
      });
      yield* storageFs.writeFile(
        storagePath,
        new TextEncoder().encode(content),
      );
      return {
        storagePath,
        absolutePath: yield* storageFs.resolve(storagePath),
      };
    },
  );
}
