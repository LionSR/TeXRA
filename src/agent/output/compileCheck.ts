import * as path from 'path';

import { getWorkspaceState } from '@agent/core/stateStore';
import { toErrorMessage } from '@common/errors';
import { WorkspaceStateKey } from '@common/state/stateKeys';
import { hasLatexCompiler } from '@latex/latexToolchain';
import { compileLatex2Pdf } from '@latex/texTools';
import type { TexraTrace } from '@logger';
import type { CompileFailure, OutputFileInfo } from '@shared/schemas';
import {
  LATEX_CONFIG_DEFAULTS,
  LATEX_CONFIG_RANGES,
} from '@shared/constants/latex';
import {
  createRunStorageLocation,
  flexibleFS,
  getComparablePath,
  pathToLocation,
  type TaskRunFileService,
} from '@utils/files';

import {
  publishCompiledPdfArtifact,
  type CompiledPdfArtifact,
} from './compiledPdfArtifacts';
import { getOutputFilesByRound, type OutputState } from './outputState';

export interface CompileCheckContext {
  fileService: TaskRunFileService;
  outputState: OutputState;
  logger: TexraTrace;
  streamId: string;
}

const LOG_TAIL_LINES = 200;
const MIN_TIMEOUT_MS = LATEX_CONFIG_RANGES.workflowAutoCompileTimeoutMs.min;

export interface CompileCheckResult {
  failures: CompileFailure[];
  artifacts: CompiledPdfArtifact[];
}

/**
 * Return a human-readable display name for an output file in compile messages.
 * Prefers the `source` field (which carries the original document name, e.g.
 * "constrained_note.tex") over the extracted-file basename.
 */
function getCompileDisplayName(file: OutputFileInfo): string {
  const rawBase = path.basename(file.location.absolutePath);
  const src = file.source;
  if (!src || src === rawBase) return rawBase;
  // Avoid leaking the generic raw-wrapper stem (`output`, `output.xml`, or the
  // pre-refactor `output.tex`) as a display name — those are run-storage
  // internals, not the meaningful document name.
  const srcBase = path.basename(src);
  const GENERIC_STEMS = new Set(['output', 'output.xml', 'output.tex']);
  return srcBase && !GENERIC_STEMS.has(srcBase) ? srcBase : rawBase;
}

/**
 * Compile each .tex output of a round to verify the workflow produced a
 * buildable document. Success is silent; failures write the log tail to
 * `<runDir>/compile/r<round>_<safe>.log`. Missing toolchains, runs without a run
 * directory, and non-root fragments are skipped gracefully.
 */
export async function runCompileCheck(
  ctx: CompileCheckContext,
  currentRound: number,
): Promise<CompileCheckResult> {
  if (
    !getWorkspaceState().get<boolean>(
      WorkspaceStateKey.WORKFLOW_AUTO_COMPILE,
      LATEX_CONFIG_DEFAULTS.workflowAutoCompile,
    )
  ) {
    return { failures: [], artifacts: [] };
  }

  const runDirectory = ctx.fileService.metadata.runDirectory;
  if (!runDirectory) {
    ctx.logger.debug('Compile check skipped: no run directory');
    return { failures: [], artifacts: [] };
  }

  const texOutputs = (
    getOutputFilesByRound(ctx.outputState)[currentRound] ?? []
  ).filter((f) => f.location.absolutePath.toLowerCase().endsWith('.tex'));
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

  const timeoutMs = Math.max(
    MIN_TIMEOUT_MS,
    getWorkspaceState().get<number>(
      WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS,
      LATEX_CONFIG_DEFAULTS.workflowAutoCompileTimeoutMs,
    ),
  );
  // compileRoot is created lazily on first failure so successful rounds leave
  // no trace — the orchestrator can use "no compile/*.log entries" as proof
  // the build succeeded.
  const compileRoot = path.join(runDirectory, 'compile');
  const failures: CompileFailure[] = [];
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
      if (result.failure) failures.push(result.failure);
      if (result.artifact) artifacts.push(result.artifact);
    } catch (err) {
      ctx.logger.warn(
        `Compile check: ${displayName} skipped — ${toErrorMessage(err)}`,
      );
    }
  }

  return { failures, artifacts };
}

interface PerFileOptions {
  compileRoot: string;
  runDirectory: string;
  timeoutMs: number;
}

async function compileOne(
  ctx: CompileCheckContext,
  outputFile: OutputFileInfo,
  currentRound: number,
  displayName: string,
  opts: PerFileOptions,
): Promise<{
  failure: CompileFailure | null;
  artifact: CompiledPdfArtifact | null;
}> {
  // compiledBasename is the actual on-disk filename LaTeX engines use when
  // naming their .log; it may differ from displayName when file.source is set.
  const compiledBasename = path.basename(outputFile.location.absolutePath);
  // Full relative path keeps two outputs sharing a basename distinct
  // (ch1/main.tex vs ch2/main.tex). Strip the leading r<N>/ segment because
  // it is already added explicitly as `r${currentRound}_` below — without
  // this, a location like `r0/main.tex` would produce `r0_r0_main.tex.log`.
  const comparablePath = getComparablePath(outputFile.location);
  const roundPrefix = `r${currentRound}/`;
  const pathForSafeName = comparablePath.startsWith(roundPrefix)
    ? comparablePath.slice(roundPrefix.length)
    : comparablePath;
  const safeName = pathForSafeName.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
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

  // Clear any stale log from a previous round so "no log = success" holds.
  await flexibleFS.delete(logDest).catch(() => undefined);

  const content = await flexibleFS.read(outputFile.location);
  if (!/\\documentclass/.test(content)) {
    ctx.logger.debug(
      `Compile check: ${displayName} has no \\documentclass, skipping`,
    );
    return { failure: null, artifact: null };
  }

  // execa's timeout option kills the child process on expiry, so we don't
  // orphan hanging latexmk/pdflatex runs.
  const ok = await compileLatex2Pdf(outputFile.location, {
    channel: ctx.streamId,
    outputDirectory: buildDir,
    timeout: opts.timeoutMs,
  });

  if (ok) {
    ctx.logger.debug(`Compile check: ${displayName} built successfully`);
    const executionId = ctx.fileService.metadata.executionId;
    const compiledPdfPath = path.join(
      buildDir,
      `${compiledBasename.replace(/\.tex$/i, '')}.pdf`,
    );
    const artifact = executionId
      ? await publishCompiledPdfArtifact({
          runDirectory: opts.runDirectory,
          executionId,
          round: currentRound,
          displayName,
          source: outputFile.location,
          compiledPdfPath,
        })
      : null;

    if (artifact) {
      ctx.logger.debug(
        `Compile check: ${displayName} PDF persisted at ${artifact.latestPdf.relativePath}`,
      );
    }
    return { failure: null, artifact };
  }

  const tail = await readLogTail(buildDir, compiledBasename);
  await flexibleFS.ensureDir(pathToLocation(opts.compileRoot));
  await flexibleFS.write(
    logDest,
    `Compile check failed for ${displayName}\nBuild directory: ${buildDir}\n\n${tail}\n`,
  );
  ctx.logger.warn(
    `Compile check: ${displayName} failed — wrote ${path.relative(opts.runDirectory, logDest.absolutePath)}`,
  );
  const executionId = ctx.fileService.metadata.executionId;
  const logLocation = executionId
    ? createRunStorageLocation(
        logDest.absolutePath,
        logRelativePath,
        executionId,
      )
    : logDest;
  return {
    failure: {
      round: currentRound,
      displayName,
      output: outputFile.location,
      log: logLocation,
      logRelativePath,
    },
    artifact: null,
  };
}

async function readLogTail(
  buildDir: string,
  compiledBasename: string,
): Promise<string> {
  // LaTeX engines drop `<basename-without-ext>.log`; strip .tex
  // case-insensitively so .TEX/.Tex map to the same file.
  const latexLogAbs = path.join(
    buildDir,
    `${compiledBasename.replace(/\.tex$/i, '')}.log`,
  );
  try {
    const full = await flexibleFS.read(pathToLocation(latexLogAbs));
    // Split on CRLF or LF so Windows logs produce clean lines; normalize the
    // tail to LF when rejoining.
    return full.split(/\r?\n/).slice(-LOG_TAIL_LINES).join('\n');
  } catch (err) {
    return `(no LaTeX log at ${latexLogAbs}: ${toErrorMessage(err)})`;
  }
}
