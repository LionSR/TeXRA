import * as path from 'path';

import { getConfig } from '@agent/core/config';
import { toErrorMessage } from '@common/errors';
import { compileLatex2Pdf } from '@latex/texTools';
import type { AgentLogger } from '@logger/AgentLogger';
import type { OutputFileInfo } from '@shared/schemas';
import {
  flexibleFS,
  getComparablePath,
  pathToLocation,
  type TaskRunFileService,
} from '@utils/files';
import { checkToolInstalled } from '@utils/system';

import { getOutputFilesByRound, type OutputState } from './outputState';

export interface CompileCheckContext {
  fileService: TaskRunFileService;
  outputState: OutputState;
  logger: AgentLogger;
  streamId: string;
}

const LOG_TAIL_LINES = 200;
const MIN_TIMEOUT_MS = 10000;

/**
 * Compile each .tex output of a round to verify the workflow produced a
 * buildable document. Success is silent; failures write the log tail to
 * `<runDir>/compile/<safe>.log`. Missing toolchains, runs without a run
 * directory, and non-root fragments are skipped gracefully.
 */
export async function runCompileCheck(
  ctx: CompileCheckContext,
  currentRound: number,
): Promise<void> {
  if (!getConfig<boolean>('texra.workflow.autoCompileAfterOutput', true)) {
    return;
  }

  const runDirectory = ctx.fileService.metadata.runDirectory;
  if (!runDirectory) {
    ctx.logger.debug('Compile check skipped: no run directory');
    return;
  }

  const texOutputs = (
    getOutputFilesByRound(ctx.outputState)[currentRound] ?? []
  ).filter((f) => f.location.absolutePath.toLowerCase().endsWith('.tex'));
  if (texOutputs.length === 0) return;

  // Skip gracefully when no LaTeX toolchain is installed so the run doesn't
  // leave stray `compile/<name>.log` artifacts that the orchestrator would
  // misread as real compile failures.
  const hasToolchain =
    (await checkToolInstalled('latexmk', false)) ||
    (await checkToolInstalled('pdflatex', false));
  if (!hasToolchain) {
    ctx.logger.debug(
      'Compile check skipped: neither latexmk nor pdflatex is installed',
    );
    return;
  }

  const timeoutMs = Math.max(
    MIN_TIMEOUT_MS,
    getConfig<number>('texra.workflow.autoCompileTimeoutMs', 120000),
  );
  // compileRoot is created lazily on first failure so successful rounds leave
  // no trace — the orchestrator can use "no compile/*.log entries" as proof
  // the build succeeded.
  const compileRoot = path.join(runDirectory, 'compile');

  for (const outputFile of texOutputs) {
    const displayName = path.basename(outputFile.location.absolutePath);
    try {
      await compileOne(ctx, outputFile, currentRound, {
        compileRoot,
        runDirectory,
        timeoutMs,
      });
    } catch (err) {
      ctx.logger.warn(
        `Compile check: ${displayName} skipped — ${toErrorMessage(err)}`,
      );
    }
  }
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
  opts: PerFileOptions,
): Promise<void> {
  const displayName = path.basename(outputFile.location.absolutePath);
  // Full relative path keeps two outputs sharing a basename distinct
  // (ch1/main.tex vs ch2/main.tex).
  const safeName = getComparablePath(outputFile.location).replaceAll(
    /[^a-zA-Z0-9._-]/g,
    '_',
  );
  const buildDir = path.join(
    opts.compileRoot,
    'build',
    `r${currentRound}`,
    safeName,
  );
  const logDest = pathToLocation(
    path.join(opts.compileRoot, `${safeName}.log`),
  );

  // Clear any stale log from a previous round so "no log = success" holds.
  await flexibleFS.delete(logDest).catch(() => undefined);

  const content = await flexibleFS.read(outputFile.location);
  if (!/\\documentclass/.test(content)) {
    ctx.logger.debug(
      `Compile check: ${displayName} has no \\documentclass, skipping`,
    );
    return;
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
    return;
  }

  const tail = await readLogTail(buildDir, displayName);
  await flexibleFS.ensureDir(pathToLocation(opts.compileRoot));
  await flexibleFS.write(
    logDest,
    `Compile check failed for ${displayName}\nBuild directory: ${buildDir}\n\n${tail}\n`,
  );
  ctx.logger.warn(
    `Compile check: ${displayName} failed — wrote ${path.relative(opts.runDirectory, logDest.absolutePath)}`,
  );
}

async function readLogTail(
  buildDir: string,
  displayName: string,
): Promise<string> {
  // LaTeX engines drop `<basename-without-ext>.log`; strip .tex
  // case-insensitively so .TEX/.Tex map to the same file.
  const latexLogAbs = path.join(
    buildDir,
    `${displayName.replace(/\.tex$/i, '')}.log`,
  );
  try {
    const full = await flexibleFS.read(pathToLocation(latexLogAbs));
    return full.split('\n').slice(-LOG_TAIL_LINES).join('\n');
  } catch (err) {
    return `(no LaTeX log at ${latexLogAbs}: ${toErrorMessage(err)})`;
  }
}
