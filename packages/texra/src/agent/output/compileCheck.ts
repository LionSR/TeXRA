import { hash } from 'node:crypto';
import * as path from 'node:path';
import {
  normalizeFilePath,
  fileLocationDisplayPath,
  type RunId,
  type FileLocation,
  type RunStorageFileLocation,
  toErrorMessage,
} from '@texra-ai/harness/schemas';
import { RunFileService } from '@texra-ai/harness/plugins';
import {
  hasExtension,
  createRunStorageLocation,
  pathToLocationIn,
  Settings,
} from '@texra-ai/harness/host';

import { Effect, FileSystem } from 'effect';

import { compileLatex2Pdf, type CompileLatex2PdfResult } from '@latex/texTools';
import {
  revisionLayout,
  stripRevisionDir,
} from '@texra/shared/constants/revisionLayout';
import { DocumentsStateKey } from '@texra/shared/settingsView/documentsSettings';
import { LATEX_CONFIG_RANGES } from '@texra/shared/constants/latexConfig';
import {
  type CompileFailure,
  isGenericOutputStem,
  type OutputFileInfo,
} from '@texra/shared/plugins/documentOutputs';

import {
  publishCompiledPdfArtifact,
  publishCompiledPdfArtifactBestEffort,
} from './compiledPdfArtifacts';
import type { AgentTrace } from '@texra-ai/harness/plugins';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { WorkspaceFs } from '@texra-ai/harness/host';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

interface CompileCheckContext {
  /** The run's session roots: its workspace, storage, and setting stores. */
  roots: WorkspaceRoots;
  fileService: RunFileService;
  logger: AgentTrace;
  runId: RunId;
}

const MIN_TIMEOUT_MS = LATEX_CONFIG_RANGES.documentsCompileTimeoutMs.min;

/** A round's check: the outputs that failed and the PDFs of those that
 *  built, or why it checked nothing, which is never zero failures. A check
 *  with something to compile that could not compile it leaves the revision
 *  unverified (`unverified`); one turned off or with no `.tex` output does
 *  not. */
type CompileCheckResult =
  | {
      readonly _tag: 'checked';
      readonly artifacts: RunStorageFileLocation[];
      readonly failures: CompileFailure[];
    }
  | {
      readonly _tag: 'skipped';
      readonly reason: string;
      readonly unverified: boolean;
    };

const skipped = (reason: string, unverified = false): CompileCheckResult => ({
  _tag: 'skipped',
  reason,
  unverified,
});

/** The compile check's timeout setting, floored at the config-range minimum. */
export const compileCheckTimeoutMs = Effect.fn('compileCheckTimeoutMs')(
  function* (roots: WorkspaceRoots) {
    return Math.max(
      MIN_TIMEOUT_MS,
      yield* Settings.get<number>(
        roots,
        DocumentsStateKey.DOCUMENTS_COMPILE_TIMEOUT_MS,
      ),
    );
  },
);

/**
 * Return a human-readable display name for an output file in compile messages.
 * Prefers the `source` field (which carries the original document name, e.g.
 * "constrained_note.tex") over the extracted-file basename.
 */
function getCompileDisplayName(file: OutputFileInfo): string {
  const rawBase = path.basename(file.location.absolutePath);
  const srcBase = file.source ? path.basename(file.source) : '';
  return srcBase && srcBase !== rawBase && !isGenericOutputStem(srcBase)
    ? srcBase
    : rawBase;
}

/**
 * Resolve a workspace/run-storage location back to its live source folder.
 * A round output's leading `r<digits>/` segment is removed. Workspace files
 * and original snapshots retain the same segment as a real directory name.
 */
export function resolveWorkspaceSourceDir(
  roots: WorkspaceRoots,
  location: FileLocation,
): string | undefined {
  const workspaceRoot = roots.workspace;
  if (!workspaceRoot || location.kind === 'external') return undefined;

  const runRelative =
    location.kind === 'runStorage'
      ? path.relative(
          new RunFileService(location.runId, roots).runDirectory,
          location.absolutePath,
        )
      : undefined;
  const workspaceRelative =
    runRelative !== undefined && stripRevisionDir(runRelative) !== runRelative
      ? stripRevisionDir(location.relativePath)
      : location.relativePath;

  return path.join(workspaceRoot, path.dirname(workspaceRelative));
}

/**
 * Compile each .tex output of a round to verify the document task produced a
 * buildable document. Success is silent; failures write the log tail to
 * the revision's compile log (`revisionLayout(...).compileLog`). Non-root fragments are skipped;
 * a check that compiles nothing says why (`skipped`).
 */
export const runCompileCheck = Effect.fn('documents.runCompileCheck')(
  function* (
    ctx: CompileCheckContext,
    currentRound: number,
    outputs: readonly OutputFileInfo[],
  ) {
    if (
      !(yield* Settings.get<boolean>(
        ctx.roots,
        DocumentsStateKey.DOCUMENTS_COMPILE_AFTER_OUTPUT,
      ))
    ) {
      return skipped('auto-compile is off');
    }

    const { runDirectory } = ctx.fileService;

    const texOutputs = outputs.filter((f) =>
      hasExtension(f.location.absolutePath, '.tex'),
    );
    if (texOutputs.length === 0)
      return skipped('the revision wrote no .tex output');

    const timeoutMs = yield* compileCheckTimeoutMs(ctx.roots);
    const failures: CompileFailure[] = [];
    const artifacts: RunStorageFileLocation[] = [];

    for (const outputFile of texOutputs) {
      const displayName = getCompileDisplayName(outputFile);
      const result = yield* compileOne(
        ctx,
        outputFile,
        currentRound,
        displayName,
        { runDirectory, timeoutMs },
      );
      // No compiler to drive is the whole check's skip, not a failure per
      // file: the run leaves no `compile/*.log` to read as a broken build.
      if (result === 'no-compiler') {
        ctx.logger.warn('Compile check skipped: no LaTeX compiler installed');
        return skipped(
          'no LaTeX compiler (latexmk or pdflatex) is installed',
          true,
        );
      }
      if (result.failure) failures.push(result.failure);
      if (result.artifact) artifacts.push(result.artifact);
    }

    return {
      _tag: 'checked',
      artifacts,
      failures,
    } satisfies CompileCheckResult;
  },
);

interface PerFileOptions {
  runDirectory: string;
  timeoutMs: number;
}

/**
 * Per-file compile context for the failure-persistence helper, constructed
 * once inside {@link compileOne} and spread into each call's args.
 */
interface CompileTarget {
  ctx: CompileCheckContext;
  opts: PerFileOptions;
  displayName: string;
  currentRound: number;
  outputFile: OutputFileInfo;
  runId: RunId;
}

/** What one output file contributed to the round's compile check. */
interface PerFileOutcome {
  failure: CompileFailure | null;
  artifact: RunStorageFileLocation | null;
}

// Short hex digest length appended to safeName below — enough to make
// collisions between distinct paths astronomically unlikely while keeping
// log filenames legible.
const PATH_HASH_LENGTH = 8;

// Cap on the sanitized stem portion of safeName (before the hash suffix).
// Most filesystems reject a single path component over ~255 bytes; a deeply
// nested or very long output path plus the round prefix, hash, and `.log`
// extension could otherwise exceed that. The hash is derived from the full,
// untruncated path, so truncating the stem never reintroduces collisions.
const MAX_SANITIZED_STEM_LENGTH = 200;

/**
 * What one `compileLatex2Pdf` attempt produced: a file with no
 * `\documentclass` is skipped without compiling, a machine with no engine to
 * drive is `no-compiler`, a file that failed before the engine could answer
 * is `errored`, and everything else carries the engine's own verdict.
 */
type CompileAttempt =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'no-compiler' }
  | { readonly kind: 'errored'; readonly message: string }
  | { readonly kind: 'compiled'; readonly result: CompileLatex2PdfResult };

const compileOne = Effect.fn('documents.compileOne')(function* (
  ctx: CompileCheckContext,
  outputFile: OutputFileInfo,
  currentRound: number,
  displayName: string,
  opts: PerFileOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  // Full relative path keeps two outputs sharing a basename distinct
  // (ch1/main.tex vs ch2/main.tex). The revision's own folder is left out,
  // since the log's name already carries the revision.
  const pathForSafeName = stripRevisionDir(
    normalizeFilePath(fileLocationDisplayPath(outputFile.location)),
    currentRound,
  );
  // Sanitizing to a filesystem-safe name is lossy: two distinct paths that
  // differ only in characters outside [a-zA-Z0-9._-] (e.g. "a:b.tex" and
  // "a_b.tex") both collapse to the same string, so a second file's log
  // write/delete would clobber the first's. Suffix with a short hash of the
  // untruncated path so every output gets its own collision-free log slot.
  const sanitizedName = pathForSafeName.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  const pathHash = hash('sha256', pathForSafeName, 'hex').slice(
    0,
    PATH_HASH_LENGTH,
  );
  const sanitizedStem = sanitizedName.slice(0, MAX_SANITIZED_STEM_LENGTH);
  const safeName = `${sanitizedStem}_${pathHash}`;
  const layout = revisionLayout(currentRound);
  const buildDir = path.join(opts.runDirectory, layout.compileBuild(safeName));
  const logRelativePath = layout.compileLog(safeName);
  const logAbsolutePath = path.join(opts.runDirectory, logRelativePath);
  const { runId } = ctx.fileService;

  const target: CompileTarget = {
    ctx,
    opts,
    displayName,
    currentRound,
    outputFile,
    runId,
  };

  // A stale log from an earlier attempt is cleared only once this file's
  // outcome is known, so a crash mid-check never masquerades as success. A
  // missing log is already clear (`force`); any other failure is named.
  const clearStaleLogs = fs.remove(logAbsolutePath, { force: true }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        ctx.logger.warn(
          `Compile check: could not clear stale log ${logRelativePath}: ${toErrorMessage(error)}`,
        );
      }),
    ),
  );

  const attempt = Effect.gen(function* (): Generator<
    Effect.Effect<
      unknown,
      Error,
      FileSystem.FileSystem | WorkspaceFs | ChildProcessSpawner
    >,
    CompileAttempt
  > {
    const content = yield* fs.readFileString(outputFile.location.absolutePath);
    if (!/\\documentclass/.test(content)) {
      ctx.logger.debug(
        `Compile check: ${displayName} has no \\documentclass, skipping`,
      );
      yield* clearStaleLogs;
      return { kind: 'skipped' };
    }

    // The output compiles from `buildDir`, not its original workspace folder.
    // For extracted outputs, the run-storage basename can be generic while
    // outputFile.source carries the real workspace path.
    const source = outputFile.source.trim();
    const locatedSource =
      source.length > 0
        ? pathToLocationIn(ctx.roots.workspace, source)
        : undefined;
    const sourceLocation =
      locatedSource?.kind === 'workspace' ? locatedSource : outputFile.location;
    const sourceDir = resolveWorkspaceSourceDir(ctx.roots, sourceLocation);
    const extraInputDirs = sourceDir ? [sourceDir] : [];

    // On the timeout the command's scope kills the child, so we don't orphan
    // hanging latexmk/pdflatex runs.
    return yield* compileLatex2Pdf(outputFile.location, ctx.roots, {
      channel: ctx.runId,
      outputDirectory: buildDir,
      timeout: opts.timeoutMs,
      extraInputDirs,
    }).pipe(
      Effect.map((result): CompileAttempt => ({ kind: 'compiled', result })),
      Effect.catchTag('ToolMissing', () =>
        Effect.succeed<CompileAttempt>({ kind: 'no-compiler' }),
      ),
    );
  }).pipe(
    // A per-file failure here (fs read error, compiler crash, …) means we
    // could not determine whether this output compiles — that must never be
    // reported as success. It becomes a failure with a synthetic excerpt,
    // persisted to the same discoverable compile/*.log slot a real compile
    // failure would use.
    Effect.catch((error) =>
      Effect.sync((): CompileAttempt => {
        const message = toErrorMessage(error);
        ctx.logger.warn(`Compile check: ${displayName} errored: ${message}`, {
          data: error,
        });
        return { kind: 'errored', message };
      }),
    ),
  );

  const attempted = yield* attempt;
  if (attempted.kind === 'no-compiler') return 'no-compiler' as const;
  if (attempted.kind === 'skipped') {
    return { failure: null, artifact: null };
  }
  if (attempted.kind === 'errored') {
    return yield* writeCompileFailure({
      ...target,
      logAbsolutePath,
      logRelativePath,
      failureLogExcerpt: `Compile check errored for ${displayName}\n\n${attempted.message}`,
    });
  }

  const compileResult = attempted.result;
  if (compileResult.ok) {
    ctx.logger.debug(`Compile check: ${displayName} built successfully`);
    yield* clearStaleLogs;
    // Publishing the PDF is best effort: a failed copy must not turn a
    // document that genuinely compiled into a reported compile failure.
    const artifact = yield* publishCompiledPdfArtifactBestEffort(
      publishCompiledPdfArtifact({
        runDirectory: opts.runDirectory,
        runId,
        round: currentRound,
        displayName,
        source: outputFile.location,
        compiledPdfPath: compileResult.pdfPath,
      }),
      (err) =>
        ctx.logger.warn(
          `Compile check: ${displayName} PDF publish failed: ${toErrorMessage(err)}`,
          { data: err },
        ),
    );
    if (artifact) {
      ctx.logger.debug(`Compile check: ${displayName} PDF persisted`, {
        data: artifact.relativePath,
      });
    }
    return { failure: null, artifact };
  }

  const failureLogExcerpt = `Compile check failed for ${displayName}\nBuild directory: ${buildDir}\n\n${compileResult.logTail}`;
  ctx.logger.warn(`Compile check: ${displayName} failed`, {
    data: path.relative(opts.runDirectory, logAbsolutePath),
  });
  return yield* writeCompileFailure({
    ...target,
    logAbsolutePath,
    logRelativePath,
    failureLogExcerpt,
  });
});

interface WriteCompileFailureArgs extends CompileTarget {
  /** Absolute path of this failure's collision-free `compile/*.log` slot. */
  logAbsolutePath: string;
  logRelativePath: string;
  failureLogExcerpt: string;
}

/**
 * Persist a failure's log excerpt to its collision-free `compile/*.log` slot
 * and build the corresponding {@link CompileFailure} record. Never fails:
 * a persistence error is logged at `warn` and recovered, so a failure is
 * always counted even when the log itself couldn't be written to disk.
 */
const writeCompileFailure = Effect.fn('documents.writeCompileFailure')(
  function* ({
    ctx,
    displayName,
    currentRound,
    outputFile,
    runId,
    logAbsolutePath,
    logRelativePath,
    failureLogExcerpt,
  }: WriteCompileFailureArgs) {
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.gen(function* () {
      // Created on the first failure, so a revision that compiles leaves
      // no compile log behind.
      yield* fs.makeDirectory(path.dirname(logAbsolutePath), {
        recursive: true,
      });
      yield* fs.writeFileString(logAbsolutePath, `${failureLogExcerpt}\n`);
    }).pipe(
      Effect.catch((writeErr) =>
        Effect.sync(() => {
          ctx.logger.warn(
            `Compile check: failed to persist log for ${displayName}: ${toErrorMessage(writeErr)}`,
            { data: writeErr },
          );
        }),
      ),
    );

    const logLocation = createRunStorageLocation(
      logAbsolutePath,
      logRelativePath,
      runId,
    );
    return {
      failure: {
        round: currentRound,
        displayName,
        output: outputFile.location,
        log: logLocation,
        logRelativePath,
      },
      artifact: null,
    } satisfies PerFileOutcome;
  },
);
