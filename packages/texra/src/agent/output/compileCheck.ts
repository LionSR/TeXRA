import { hash } from 'node:crypto';
import * as path from 'node:path';
import {
  normalizeFilePath,
  fileLocationDisplayPath,
  type FileLocation,
  type RunStorageFileLocation,
  toErrorMessage,
  hasExtension,
} from '@texra-ai/worldline/schemas';
import { runDirUnder, pathToLocationIn } from '@texra-ai/worldline/plugins';
import type { RunWorkspace } from '@texra/tools/documents/runWorkspace';

import { Effect, FileSystem } from 'effect';

import { compileLatex2Pdf } from '@latex/texTools';
import {
  revisionLayout,
  stripRevisionDir,
} from '@texra/shared/constants/revisionLayout';
import {
  type CompileFailure,
  outputDisplayName,
  type OutputFileInfo,
} from '@texra/shared/plugins/documentOutputs';

import { recoverLogged } from '@texra/utils/diagnostics/recoverLogged';

import { publishCompiledPdfArtifact } from './compiledPdfArtifacts';
import {
  type AgentTrace,
  Settings,
  withLogChannel,
} from '@texra-ai/worldline/plugins';
import type { WorkspaceRoots } from '@texra-ai/worldline';
import {
  DOCUMENTS_COMPILE_AFTER_OUTPUT_SETTING,
  DOCUMENTS_COMPILE_TIMEOUT_SETTING,
} from '@texra/shared/settings/documentsSettings';

interface CompileCheckContext {
  /** The run's session roots: its workspace, storage, and setting stores. */
  roots: WorkspaceRoots;
  /** The run's files; its `runId` names the run. */
  fileService: RunWorkspace;
  logger: AgentTrace;
  /** Directories the compile searches besides the output's own: where the
   *  task's templates live (a poster's theme `.sty`). */
  inputDirs: readonly string[];
}

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
          runDirUnder(roots.storage, location.runId),
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
      !(yield* Settings.get(ctx.roots, DOCUMENTS_COMPILE_AFTER_OUTPUT_SETTING))
    ) {
      return skipped('auto-compile is off');
    }

    const { runDirectory } = ctx.fileService;

    const texOutputs = outputs.filter((f) =>
      hasExtension(f.location.absolutePath, '.tex'),
    );
    if (texOutputs.length === 0)
      return skipped('the revision wrote no .tex output');

    const timeoutMs = yield* Settings.get(
      ctx.roots,
      DOCUMENTS_COMPILE_TIMEOUT_SETTING,
    );
    const failures: CompileFailure[] = [];
    const artifacts: RunStorageFileLocation[] = [];

    for (const outputFile of texOutputs) {
      // The name the output reads by everywhere, without its folders: a
      // compile message and the published PDF name the file, not the path.
      const displayName = path.basename(outputDisplayName(outputFile));
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

/** What one output file contributed to the round's compile check. */
interface PerFileOutcome {
  failure: CompileFailure | null;
  artifact: RunStorageFileLocation | null;
}

// Short hex digest length appended to a slot name — enough to make
// collisions between distinct paths astronomically unlikely while keeping
// file names legible.
const PATH_HASH_LENGTH = 8;

// Cap on the sanitized stem portion of a slot name (before the hash suffix).
// Most filesystems reject a single path component over ~255 bytes; a deeply
// nested or very long output path plus a prefix, the hash and an extension
// could otherwise exceed that. The hash is derived from the full,
// untruncated path, so truncating the stem never reintroduces collisions.
const MAX_SANITIZED_STEM_LENGTH = 200;

/**
 * The rule that names an output's derived files in run storage (its compile
 * log and build folder, its diff) as one path component. Each caller passes
 * the path its directory needs to keep apart: the compile log and build
 * folder sit in a per-round directory and take the path without its round,
 * while every round's diff shares one `diffs/` folder and keeps the round.
 * The full path keeps two outputs sharing a basename distinct (ch1/main.tex
 * vs ch2/main.tex). Sanitizing to a filesystem-safe name is lossy: two
 * paths that differ only in characters outside [a-zA-Z0-9._-] ("a:b.tex"
 * and "a_b.tex", or "a/b.tex" and "a_b.tex") collapse to one string, so a
 * short hash of the untruncated path gives each output its own slot.
 */
export function outputSlotName(outputPath: string): string {
  const sanitizedName = outputPath.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  const pathHash = hash('sha256', outputPath, 'hex').slice(0, PATH_HASH_LENGTH);
  return `${sanitizedName.slice(0, MAX_SANITIZED_STEM_LENGTH)}_${pathHash}`;
}

/**
 * Compile one output: a file with no `\documentclass` is skipped without
 * compiling, a machine with no engine to drive is `no-compiler`, and an
 * unreadable file or a failed build is a failure with its log excerpt.
 */
const compileOne = Effect.fn('documents.compileOne')(function* (
  ctx: CompileCheckContext,
  outputFile: OutputFileInfo,
  currentRound: number,
  displayName: string,
  opts: PerFileOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  // The revision's own folder is left out, since the log's name already
  // carries the revision.
  const safeName = outputSlotName(
    stripRevisionDir(
      normalizeFilePath(fileLocationDisplayPath(outputFile.location)),
      currentRound,
    ),
  );
  const layout = revisionLayout(currentRound);
  const buildDir = path.join(opts.runDirectory, layout.compileBuild(safeName));
  const logRelativePath = layout.compileLog(safeName);
  const logAbsolutePath = path.join(opts.runDirectory, logRelativePath);
  const { runId } = ctx.fileService;

  // A stale log from an earlier attempt is cleared only once this file's
  // outcome is known, so a crash mid-check never masquerades as success. A
  // missing log is already clear (`force`); any other failure is named.
  const clearStaleLogs = fs.remove(logAbsolutePath, { force: true }).pipe(
    recoverLogged(
      (error) =>
        ctx.logger.warn(
          `Compile check: could not clear stale log ${logRelativePath}: ${toErrorMessage(error)}`,
        ),
      () => Effect.void,
    ),
  );

  /**
   * Persist a failure's log excerpt to this file's collision-free
   * `compile/*.log` slot and build its {@link CompileFailure} record. Never
   * fails: a persistence error is logged at `warn` and recovered, so a
   * failure is always counted even when its log could not be written.
   */
  const writeCompileFailure = Effect.fn('documents.writeCompileFailure')(
    function* (failureLogExcerpt: string) {
      yield* Effect.gen(function* () {
        // Created on the first failure, so a revision that compiles leaves
        // no compile log behind.
        yield* fs.makeDirectory(path.dirname(logAbsolutePath), {
          recursive: true,
        });
        yield* fs.writeFileString(logAbsolutePath, `${failureLogExcerpt}\n`);
      }).pipe(
        recoverLogged(
          (writeErr) =>
            ctx.logger.warn(
              `Compile check: failed to persist log for ${displayName}: ${toErrorMessage(writeErr)}`,
              { data: writeErr },
            ),
          () => Effect.void,
        ),
      );

      return {
        failure: {
          round: currentRound,
          displayName,
          output: outputFile.location,
          log: {
            kind: 'runStorage',
            absolutePath: logAbsolutePath,
            relativePath: logRelativePath,
            runId,
          },
          logRelativePath,
        },
        artifact: null,
      } satisfies PerFileOutcome;
    },
  );

  // A file that cannot be read is one we could not determine compiles, which
  // must never be reported as success. It becomes a failure with a
  // synthetic excerpt, persisted to the same discoverable compile/*.log slot
  // a real compile failure would use.
  const content = yield* fs
    .readFileString(outputFile.location.absolutePath)
    .pipe(
      recoverLogged(
        (error) =>
          ctx.logger.warn(
            `Compile check: ${displayName} errored: ${toErrorMessage(error)}`,
            { data: error },
          ),
        (error) =>
          writeCompileFailure(
            `Compile check errored for ${displayName}\n\n${toErrorMessage(error)}`,
          ),
      ),
    );
  if (typeof content !== 'string') return content;
  if (!/\\documentclass/.test(content)) {
    ctx.logger.debug(
      `Compile check: ${displayName} has no \\documentclass, skipping`,
    );
    yield* clearStaleLogs;
    return { failure: null, artifact: null } satisfies PerFileOutcome;
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
  const extraInputDirs = [...(sourceDir ? [sourceDir] : []), ...ctx.inputDirs];

  // On the timeout the command's scope kills the child, so we don't orphan
  // hanging latexmk/pdflatex runs.
  const compileResult = yield* compileLatex2Pdf(
    outputFile.location,
    ctx.roots,
    {
      outputDirectory: buildDir,
      timeout: opts.timeoutMs,
      extraInputDirs,
    },
  ).pipe(
    withLogChannel(runId),
    Effect.catchTag('ToolMissing', () =>
      Effect.succeed('no-compiler' as const),
    ),
  );
  if (compileResult === 'no-compiler') return compileResult;
  if (compileResult.ok) {
    ctx.logger.debug(`Compile check: ${displayName} built successfully`);
    yield* clearStaleLogs;
    // Publishing the PDF is best effort: a failed copy must not turn a
    // document that genuinely compiled into a reported compile failure.
    const artifact = yield* publishCompiledPdfArtifact({
      runDirectory: opts.runDirectory,
      runId,
      round: currentRound,
      displayName,
      source: outputFile.location,
      compiledPdfPath: compileResult.pdfPath,
    }).pipe(
      recoverLogged(
        (err) =>
          ctx.logger.warn(
            `Compile check: ${displayName} PDF publish failed: ${toErrorMessage(err)}`,
            { data: err },
          ),
        () => Effect.succeed(null),
      ),
    );
    if (artifact) {
      ctx.logger.debug(`Compile check: ${displayName} PDF persisted`, {
        data: artifact.relativePath,
      });
    }
    return { failure: null, artifact } satisfies PerFileOutcome;
  }

  ctx.logger.warn(`Compile check: ${displayName} failed`, {
    data: path.relative(opts.runDirectory, logAbsolutePath),
  });
  return yield* writeCompileFailure(
    `Compile check failed for ${displayName}\nBuild directory: ${buildDir}\n\n${compileResult.logTail}`,
  );
});
