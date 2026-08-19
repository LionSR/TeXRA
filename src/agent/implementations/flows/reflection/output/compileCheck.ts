import * as path from 'node:path';

import type { AgentTrace } from '@agent/trace';
import { compileLatex2Pdf, type CompileLatex2PdfResult } from '@latex/texTools';
import { hasLatexCompiler } from '@latex/latexToolchain';
import {
  fileLocationDisplayPath,
  isGenericOutputStem,
  type CompileFailure,
  type CompileResult,
  type ExecutionId,
  type FileLocation,
  type OutputFileInfo,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { LATEX_CONFIG_RANGES } from '@shared/constants/latexConfig';
import { parseWorkflowOutputRoundDir } from '@shared/constants/workflowOutput';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import {
  createRunStorageLocation,
  pathToLocation,
} from '@utils/files/fileLocation';
import { type TaskRunFileService } from '@utils/files/taskRunStorage';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { truncatedHexId } from '@utils/core/idHash';
import { hasExtension } from '@utils/core/pathCore';
import { readPlatformSetting } from '@utils/config/platformSettings';
import { getRunDir } from '@utils/files/runStorageFs';
import { sanitizePathSegment } from '@utils/text/sanitizePathSegment';

import {
  publishCompiledPdfArtifact,
  type CompiledPdfArtifact,
} from './compiledPdfArtifacts';
import { getOutputFilesByRound, type OutputState } from './outputState';

export interface CompileCheckContext {
  fileService: TaskRunFileService;
  outputState: OutputState;
  logger: AgentTrace;
  streamId: string;
}

const COMPILE_LOG_EXCERPT_CHAR_LIMIT = 12000;
const MIN_TIMEOUT_MS = LATEX_CONFIG_RANGES.workflowAutoCompileTimeoutMs.min;

export interface CompileCheckResult {
  failures: CompileFailure[];
  artifacts: CompiledPdfArtifact[];
  compileResult?: CompileResult;
}

/** Workflow auto-compile timeout, floored at the config-range minimum. */
export function getWorkflowAutoCompileTimeoutMs(): number {
  return Math.max(
    MIN_TIMEOUT_MS,
    readPlatformSetting<number>(
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
  location: FileLocation,
): string | undefined {
  const workspaceRoot = WorkspaceFS.getPath();
  if (!workspaceRoot || location.kind === 'external') return undefined;

  const runStorageRelative =
    location.kind === 'runStorage'
      ? path.relative(getRunDir(location.executionId), location.absolutePath)
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
export async function runCompileCheck(
  ctx: CompileCheckContext,
  currentRound: number,
): Promise<CompileCheckResult> {
  if (!readPlatformSetting<boolean>(WorkspaceStateKey.WORKFLOW_AUTO_COMPILE)) {
    return { failures: [], artifacts: [] };
  }

  const { runDirectory } = ctx.fileService;

  const texOutputs = (
    getOutputFilesByRound(ctx.outputState)[currentRound] ?? []
  ).filter((f) => hasExtension(f.location.absolutePath, '.tex'));
  if (texOutputs.length === 0) return { failures: [], artifacts: [] };

  // Skip gracefully when no LaTeX toolchain is installed so the run doesn't
  // leave stray `compile/<name>.log` artifacts that the orchestrator would
  // misread as real compile failures.
  if (!(await hasLatexCompiler())) {
    ctx.logger.debug(
      'Compile check skipped: neither latexmk nor pdflatex is installed',
    );
    return { failures: [], artifacts: [] };
  }

  const timeoutMs = getWorkflowAutoCompileTimeoutMs();
  // compileRoot is created lazily on first failure so successful rounds leave
  // no trace — the orchestrator can use "no compile/*.log entries" as proof
  // the build succeeded.
  const compileRoot = path.join(runDirectory, 'compile');
  const failures: CompileFailure[] = [];
  const failureLogExcerpts: string[] = [];
  const artifacts: CompiledPdfArtifact[] = [];

  for (const outputFile of texOutputs) {
    const displayName = getCompileDisplayName(outputFile);
    try {
      const result = await compileOne(
        ctx,
        outputFile,
        currentRound,
        displayName,
        {
          compileRoot,
          runDirectory,
          timeoutMs,
        },
      );
      if (result.failure) {
        failures.push(result.failure);
        failureLogExcerpts.push(result.failureLogExcerpt);
      }
      if (result.artifact) artifacts.push(result.artifact);
    } catch (err) {
      // compileOne handles its own read/compile exceptions internally and
      // reports them as failures, never as skips — this catch is only a
      // last-resort backstop for a bug in that handling itself. It must still
      // never let an errored check masquerade as a successful round, so it
      // records a failure (with no on-disk log, since we can't trust the
      // paths that failed to compute) rather than swallowing the error.
      const message = toErrorMessage(err);
      ctx.logger.warn(`Compile check: ${displayName} errored: ${message}`, {
        data: err,
      });
      // logRelativePath must stay a real, resolvable path: downstream
      // consumers build a `/files/${logRelativePath}` deep link and an "open
      // compile log" action around `log.absolutePath` — a placeholder string
      // here would silently break both. Fall back to the output file's own
      // comparable path (still useful context, even though it isn't a log).
      let fallbackRelativePath: string;
      try {
        fallbackRelativePath = fileLocationDisplayPath(outputFile.location);
      } catch {
        fallbackRelativePath = outputFile.location.absolutePath;
      }
      failures.push({
        round: currentRound,
        displayName,
        output: outputFile.location,
        log: outputFile.location,
        logRelativePath: fallbackRelativePath,
      });
      failureLogExcerpts.push(
        `Compile check errored for ${displayName}\n\n${message}`,
      );
    }
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

  return { failures, artifacts, compileResult };
}

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
  executionId: ExecutionId;
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

async function compileOne(
  ctx: CompileCheckContext,
  outputFile: OutputFileInfo,
  currentRound: number,
  displayName: string,
  opts: PerFileOptions,
): Promise<{
  failure: CompileFailure | null;
  failureLogExcerpt: string;
  artifact: CompiledPdfArtifact | null;
}> {
  // Full relative path keeps two outputs sharing a basename distinct
  // (ch1/main.tex vs ch2/main.tex). Strip the leading r<N>/ segment because
  // it is already added explicitly as `r${currentRound}_` below — without
  // this, a location like `r0/main.tex` would produce `r0_r0_main.tex.log`.
  const rawComparablePath = fileLocationDisplayPath(outputFile.location);
  const comparablePath = rawComparablePath.replaceAll('\\', '/');
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
  const logDest = pathToLocation(
    path.join(opts.compileRoot, `r${currentRound}_${safeName}.log`),
  );
  const logRelativePath = path.join(
    'compile',
    `r${currentRound}_${safeName}.log`,
  );
  const { executionId } = ctx.fileService;

  const target: CompileTarget = {
    ctx,
    opts,
    displayName,
    currentRound,
    outputFile,
    executionId,
  };

  const clearStaleLogs = (): Promise<void> =>
    AbsoluteFS.delete(logDest.absolutePath).catch(() => undefined);

  let compileResult: CompileLatex2PdfResult;
  try {
    const content = await AbsoluteFS.read(outputFile.location.absolutePath);
    if (!/\\documentclass/.test(content)) {
      ctx.logger.debug(
        `Compile check: ${displayName} has no \\documentclass, skipping`,
      );
      // Only clear a stale log now that we know this file needs no compile
      // check — deleting it up front (before we know the outcome) would let a
      // mid-check crash erase evidence of a real prior failure.
      await clearStaleLogs();
      return { failure: null, failureLogExcerpt: '', artifact: null };
    }

    // The output compiles from `buildDir`, not its original workspace folder.
    // For extracted outputs, the run-storage basename can be generic while
    // outputFile.source carries the real workspace path.
    const source = outputFile.source.trim();
    const locatedSource =
      source.length > 0 ? WorkspaceFS.locatePath(source) : undefined;
    const sourceLocation =
      locatedSource?.kind === 'workspace' ? locatedSource : outputFile.location;
    const sourceDir = resolveWorkspaceSourceDir(sourceLocation);
    const extraInputDirs = sourceDir ? [sourceDir] : [];

    // execa's timeout option kills the child process on expiry, so we don't
    // orphan hanging latexmk/pdflatex runs.
    compileResult = await compileLatex2Pdf(outputFile.location, {
      channel: ctx.streamId,
      outputDirectory: buildDir,
      timeout: opts.timeoutMs,
      extraInputDirs,
    });
  } catch (err) {
    // A per-file exception here (fs read error, compiler crash, etc.) means
    // we could not determine whether this output compiles — that must never
    // be reported as success. Record it as a failure with a synthetic
    // excerpt, persisted to the same discoverable compile/*.log slot a real
    // compile failure would use.
    const message = toErrorMessage(err);
    ctx.logger.warn(`Compile check: ${displayName} errored: ${message}`, {
      data: err,
    });
    return writeCompileFailure({
      ...target,
      logDest,
      logRelativePath,
      failureLogExcerpt: `Compile check errored for ${displayName}\n\n${message}`,
    });
  }

  if (compileResult.ok) {
    ctx.logger.debug(`Compile check: ${displayName} built successfully`);
    // Only now that we know the outcome do we clear a stale failure log from
    // a previous attempt at this round — clearing it up front would leave a
    // crash mid-check masquerading as success.
    await clearStaleLogs();
    const artifact = await tryPublishArtifact({
      ...target,
      compiledPdfPath: compileResult.pdfPath,
    });
    return { failure: null, failureLogExcerpt: '', artifact };
  }

  const failureLogExcerpt = `Compile check failed for ${displayName}\nBuild directory: ${buildDir}\n\n${compileResult.logTail}`;
  ctx.logger.warn(`Compile check: ${displayName} failed`, {
    data: path.relative(opts.runDirectory, logDest.absolutePath),
  });
  return writeCompileFailure({
    ...target,
    logDest,
    logRelativePath,
    failureLogExcerpt,
  });
}

interface WriteCompileFailureArgs extends CompileTarget {
  logDest: FileLocation;
  logRelativePath: string;
  failureLogExcerpt: string;
}

/**
 * Persist a failure's log excerpt to its collision-free `compile/*.log` slot
 * and build the corresponding {@link CompileFailure} record. Never throws:
 * persistence errors are logged and swallowed so a failure is always counted
 * even when the log itself couldn't be written to disk.
 */
async function writeCompileFailure({
  ctx,
  opts,
  displayName,
  currentRound,
  outputFile,
  executionId,
  logDest,
  logRelativePath,
  failureLogExcerpt,
}: WriteCompileFailureArgs): Promise<{
  failure: CompileFailure;
  failureLogExcerpt: string;
  artifact: null;
}> {
  try {
    await AbsoluteFS.ensureDir(opts.compileRoot);
    await AbsoluteFS.write(logDest.absolutePath, `${failureLogExcerpt}\n`);
  } catch (writeErr) {
    ctx.logger.warn(
      `Compile check: failed to persist log for ${displayName}: ${toErrorMessage(writeErr)}`,
      { data: writeErr },
    );
  }

  const logLocation = createRunStorageLocation(
    logDest.absolutePath,
    logRelativePath,
    executionId,
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
  };
}

interface TryPublishArtifactArgs extends CompileTarget {
  compiledPdfPath: string;
}

/**
 * Publish the compiled PDF as a best-effort side effect of a successful
 * compile. A failure here (e.g. copying the PDF into run storage) must not
 * turn a document that genuinely compiled into a reported compile failure.
 */
async function tryPublishArtifact({
  ctx,
  opts,
  displayName,
  currentRound,
  outputFile,
  compiledPdfPath,
  executionId,
}: TryPublishArtifactArgs): Promise<CompiledPdfArtifact | null> {
  try {
    const artifact = await publishCompiledPdfArtifact({
      runDirectory: opts.runDirectory,
      executionId,
      round: currentRound,
      displayName,
      source: outputFile.location,
      compiledPdfPath,
    });
    if (artifact) {
      ctx.logger.debug(`Compile check: ${displayName} PDF persisted`, {
        data: artifact.latestPdf.relativePath,
      });
    }
    return artifact;
  } catch (err) {
    ctx.logger.warn(
      `Compile check: ${displayName} PDF publish failed: ${toErrorMessage(err)}`,
      { data: err },
    );
    return null;
  }
}

function combineFailureLogExcerpts(excerpts: string[]): string {
  const combined = excerpts.filter(Boolean).join('\n\n');
  if (combined.length <= COMPILE_LOG_EXCERPT_CHAR_LIMIT) return combined;

  return [
    `[truncated to last ${COMPILE_LOG_EXCERPT_CHAR_LIMIT} characters]`,
    combined.slice(-COMPILE_LOG_EXCERPT_CHAR_LIMIT),
  ].join('\n');
}
