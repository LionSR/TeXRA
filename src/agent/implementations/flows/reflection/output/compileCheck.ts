import * as path from 'node:path';

import { Cause, Effect, FileSystem } from 'effect';

import type { AgentTrace } from '@agent/trace';
import { compileLatex2Pdf, type CompileLatex2PdfResult } from '@latex/texTools';
import { hasLatexCompiler } from '@latex/latexToolchain';
import type { WorkspaceFs } from '@platform/rootedFs';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  fileLocationDisplayPath,
  isGenericOutputStem,
  type CompileFailure,
  type CompileResult,
  type RunId,
  type FileLocation,
  type OutputFileInfo,
  type RunStorageFileLocation,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { LATEX_CONFIG_RANGES } from '@shared/constants/latexConfig';
import { parseWorkflowOutputRoundDir } from '@shared/constants/workflowOutput';
import { createRunStorageLocation } from '@utils/files/fileLocation';
import { readNormalizedFile } from '@utils/files/fsDurability';
import { runDirUnder } from '@utils/files/runStorageFs';
import { type RunFileService } from '@utils/files/runStorage';
import { locateInWorkspace } from '@utils/files/workspaceFS';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { normalizeFilePath } from '@utils/core';
import { truncatedHexId } from '@utils/core/idHash';
import { hasExtension } from '@utils/core/pathCore';
import { readSettingFrom } from '@utils/config/platformSettings';
import { sanitizePathSegment } from '@utils/text/sanitizePathSegment';

import {
  publishCompiledPdfArtifact,
  publishCompiledPdfArtifactBestEffort,
} from './compiledPdfArtifacts';
import { getOutputFilesByRound, type OutputState } from './outputState';

interface CompileCheckContext {
  /** The run's session roots: its workspace, storage, and setting stores. */
  roots: WorkspaceRoots;
  fileService: RunFileService;
  outputState: OutputState;
  logger: AgentTrace;
  runId: RunId;
}

const COMPILE_LOG_EXCERPT_CHAR_LIMIT = 12000;
const MIN_TIMEOUT_MS = LATEX_CONFIG_RANGES.workflowAutoCompileTimeoutMs.min;

interface CompileCheckResult {
  artifacts: RunStorageFileLocation[];
  /** Absent when no check ran at all, which is not the same as zero failures. */
  compileResult?: CompileResult;
}

/** The failures a compile result carries; empty when it passed or never ran. */
export function compileFailuresOf(
  result: CompileResult | undefined,
): CompileFailure[] {
  return result?.status === 'failed' ? result.failures : [];
}

/** Workflow auto-compile timeout, floored at the config-range minimum. */
export function getWorkflowAutoCompileTimeoutMs(roots: WorkspaceRoots): number {
  return Math.max(
    MIN_TIMEOUT_MS,
    readSettingFrom<number>(
      roots,
      WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS,
    ),
  );
}

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

  const runStorageRelative =
    location.kind === 'runStorage'
      ? path.relative(
          runDirUnder(roots.storage, location.runId),
          location.absolutePath,
        )
      : null;
  const separatorMatch = runStorageRelative
    ? /^([^/\\]+)[/\\]/.exec(runStorageRelative)
    : null;
  const workspaceRelative =
    separatorMatch && parseWorkflowOutputRoundDir(separatorMatch[1]) !== null
      ? location.relativePath.slice(separatorMatch[0].length)
      : location.relativePath;

  return path.join(workspaceRoot, path.dirname(workspaceRelative));
}

/**
 * Compile each .tex output of a round to verify the workflow produced a
 * buildable document. Success is silent; failures write the log tail to
 * `<runDir>/compile/r<round>_<safe>.log`. Missing toolchains and non-root
 * fragments are skipped gracefully.
 */
export const runCompileCheck = Effect.fn('reflection.runCompileCheck')(
  function* (ctx: CompileCheckContext, currentRound: number) {
    const empty: CompileCheckResult = { artifacts: [] };
    if (
      !readSettingFrom<boolean>(
        ctx.roots,
        WorkspaceStateKey.WORKFLOW_AUTO_COMPILE,
      )
    ) {
      return empty;
    }

    const { runDirectory } = ctx.fileService;

    const texOutputs = (
      getOutputFilesByRound(ctx.outputState)[currentRound] ?? []
    ).filter((f) => hasExtension(f.location.absolutePath, '.tex'));
    if (texOutputs.length === 0) return empty;

    // Skip gracefully when no LaTeX toolchain is installed so the run doesn't
    // leave stray `compile/<name>.log` artifacts that the orchestrator would
    // misread as real compile failures.
    if (!(yield* hasLatexCompiler())) {
      ctx.logger.debug(
        'Compile check skipped: neither latexmk nor pdflatex is installed',
      );
      return empty;
    }

    const timeoutMs = getWorkflowAutoCompileTimeoutMs(ctx.roots);
    // compileRoot is created lazily on first failure so successful rounds
    // leave no trace — the orchestrator can use "no compile/*.log entries" as
    // proof the build succeeded.
    const compileRoot = path.join(runDirectory, 'compile');
    const failures: CompileFailure[] = [];
    const failureLogExcerpts: string[] = [];
    const artifacts: RunStorageFileLocation[] = [];

    for (const outputFile of texOutputs) {
      const displayName = getCompileDisplayName(outputFile);
      const result = yield* compileOne(
        ctx,
        outputFile,
        currentRound,
        displayName,
        { compileRoot, runDirectory, timeoutMs },
      ).pipe(
        // compileOne handles its own read/compile failures internally and
        // reports them as failures, never as skips — this recovery is only a
        // last-resort backstop for a defect in that handling itself. It must
        // still never let an errored check masquerade as a successful round,
        // so it records a failure (with no on-disk log, since we cannot trust
        // the paths that failed to compute) rather than swallowing the cause.
        // Interruption is not a failed compile and stays a cancelled run.
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.sync((): PerFileOutcome => {
                const message = toErrorMessage(Cause.squash(cause));
                ctx.logger.warn(
                  `Compile check: ${displayName} errored: ${message}`,
                  { data: cause },
                );
                return {
                  // logRelativePath must stay a real, resolvable path:
                  // downstream consumers build a `/files/${logRelativePath}`
                  // deep link and an "open compile log" action around
                  // `log.absolutePath` — a placeholder string here would
                  // silently break both. Fall back to the output file's own
                  // comparable path (still useful context, even though it is
                  // not a log).
                  failure: {
                    round: currentRound,
                    displayName,
                    output: outputFile.location,
                    log: outputFile.location,
                    logRelativePath: fileLocationDisplayPath(
                      outputFile.location,
                    ),
                  },
                  failureLogExcerpt: `Compile check errored for ${displayName}\n\n${message}`,
                  artifact: null,
                };
              }),
        ),
      );
      if (result.failure) {
        failures.push(result.failure);
        failureLogExcerpts.push(result.failureLogExcerpt);
      }
      if (result.artifact) artifacts.push(result.artifact);
    }

    const compileResult: CompileResult =
      failures.length > 0
        ? {
            status: 'failed',
            round: currentRound,
            failures,
            logExcerpt: combineFailureLogExcerpts(failureLogExcerpts),
          }
        : {
            status: 'ok',
            round: currentRound,
          };

    return { artifacts, compileResult } satisfies CompileCheckResult;
  },
);

interface PerFileOptions {
  compileRoot: string;
  runDirectory: string;
  timeoutMs: number;
}

/**
 * Per-file compile context shared by the failure-persistence and
 * artifact-publish helpers. Constructed once inside {@link compileOne} and
 * spread into each helper's args so a new derived value only needs adding
 * here (and to the helper that consumes it), not to every call site.
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
  failureLogExcerpt: string;
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
 * `\documentclass` is skipped without compiling, a file that failed before
 * the engine could answer is `errored`, and everything else carries the
 * engine's own verdict.
 */
type CompileAttempt =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'errored'; readonly message: string }
  | { readonly kind: 'compiled'; readonly result: CompileLatex2PdfResult };

const compileOne = Effect.fn('reflection.compileOne')(function* (
  ctx: CompileCheckContext,
  outputFile: OutputFileInfo,
  currentRound: number,
  displayName: string,
  opts: PerFileOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  // Full relative path keeps two outputs sharing a basename distinct
  // (ch1/main.tex vs ch2/main.tex). Strip the leading r<N>/ segment because
  // it is already added explicitly as `r${currentRound}_` below — without
  // this, a location like `r0/main.tex` would produce `r0_r0_main.tex.log`.
  const rawComparablePath = fileLocationDisplayPath(outputFile.location);
  const comparablePath = normalizeFilePath(rawComparablePath);
  const roundPrefix = `r${currentRound}/`;
  const pathForSafeName = comparablePath.startsWith(roundPrefix)
    ? comparablePath.slice(roundPrefix.length)
    : comparablePath;
  // Sanitizing to a filesystem-safe name is lossy: two distinct paths that
  // differ only in characters outside [a-zA-Z0-9._-] (e.g. "a:b.tex" and
  // "a_b.tex") both collapse to the same string, so a second file's log
  // write/delete would clobber the first's. Suffix with a short hash of the
  // untruncated path so every output gets its own collision-free log slot.
  const sanitizedName = sanitizePathSegment(pathForSafeName, {
    invalidCharPattern: /[^a-zA-Z0-9._-]/g,
    replacement: '_',
  });
  const pathHash = truncatedHexId(pathForSafeName, PATH_HASH_LENGTH);
  const sanitizedStem = sanitizedName.slice(0, MAX_SANITIZED_STEM_LENGTH);
  const safeName = `${sanitizedStem}_${pathHash}`;
  const buildDir = path.join(
    opts.compileRoot,
    'build',
    `r${currentRound}`,
    safeName,
  );
  const logFileName = `r${currentRound}_${safeName}.log`;
  const logAbsolutePath = path.join(opts.compileRoot, logFileName);
  const logRelativePath = path.join('compile', logFileName);
  const { runId } = ctx.fileService;

  const target: CompileTarget = {
    ctx,
    opts,
    displayName,
    currentRound,
    outputFile,
    runId,
  };

  // A stale log from a previous attempt at this round is only ever cleared
  // once this file's outcome is known — clearing it up front would leave a
  // crash mid-check masquerading as success. A log that is not there is
  // already clear (`force`, as the provider behind the facade already was),
  // which is the only failure this passes over silently; any other one leaves
  // last round's log in place, so it is named.
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
    Effect.Effect<unknown, Error, FileSystem.FileSystem | WorkspaceFs>,
    CompileAttempt
  > {
    const content = yield* readNormalizedFile(
      fs,
      outputFile.location.absolutePath,
    );
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
        ? locateInWorkspace(ctx.roots.workspace, source)
        : undefined;
    const sourceLocation =
      locatedSource?.kind === 'workspace' ? locatedSource : outputFile.location;
    const sourceDir = resolveWorkspaceSourceDir(ctx.roots, sourceLocation);
    const extraInputDirs = sourceDir ? [sourceDir] : [];

    // execa's timeout option kills the child process on expiry, so we don't
    // orphan hanging latexmk/pdflatex runs.
    const result = yield* compileLatex2Pdf(
      outputFile.location,
      ctx.roots.config,
      {
        channel: ctx.runId,
        outputDirectory: buildDir,
        timeout: opts.timeoutMs,
        extraInputDirs,
      },
    );
    return { kind: 'compiled', result };
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
  if (attempted.kind === 'skipped') {
    return { failure: null, failureLogExcerpt: '', artifact: null };
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
    const artifact = yield* tryPublishArtifact({
      ...target,
      compiledPdfPath: compileResult.pdfPath,
    });
    return { failure: null, failureLogExcerpt: '', artifact };
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
const writeCompileFailure = Effect.fn('reflection.writeCompileFailure')(
  function* ({
    ctx,
    opts,
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
      yield* fs.makeDirectory(opts.compileRoot, { recursive: true });
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
      failureLogExcerpt,
      artifact: null,
    } satisfies PerFileOutcome;
  },
);

interface TryPublishArtifactArgs extends CompileTarget {
  compiledPdfPath: string;
}

/**
 * Publish the compiled PDF as a best-effort side effect of a successful
 * compile. A failure here (e.g. copying the PDF into run storage) must not
 * turn a document that genuinely compiled into a reported compile failure.
 */
const tryPublishArtifact = ({
  ctx,
  opts,
  displayName,
  currentRound,
  outputFile,
  compiledPdfPath,
  runId,
}: TryPublishArtifactArgs): Effect.Effect<
  RunStorageFileLocation | null,
  never,
  FileSystem.FileSystem
> =>
  publishCompiledPdfArtifactBestEffort(
    publishCompiledPdfArtifact({
      runDirectory: opts.runDirectory,
      runId,
      round: currentRound,
      displayName,
      source: outputFile.location,
      compiledPdfPath,
    }),
    (err) =>
      ctx.logger.warn(
        `Compile check: ${displayName} PDF publish failed: ${toErrorMessage(err)}`,
        { data: err },
      ),
  ).pipe(
    Effect.tap((artifact) =>
      Effect.sync(() => {
        if (artifact) {
          ctx.logger.debug(`Compile check: ${displayName} PDF persisted`, {
            data: artifact.relativePath,
          });
        }
      }),
    ),
  );

function combineFailureLogExcerpts(excerpts: string[]): string {
  const combined = excerpts.filter(Boolean).join('\n\n');
  if (combined.length <= COMPILE_LOG_EXCERPT_CHAR_LIMIT) return combined;

  return [
    `[truncated to last ${COMPILE_LOG_EXCERPT_CHAR_LIMIT} characters]`,
    combined.slice(-COMPILE_LOG_EXCERPT_CHAR_LIMIT),
  ].join('\n');
}
