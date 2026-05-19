import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { defineCommand } from 'citty';
import { z } from 'zod';

import { toErrorMessage } from '@common/errors/errorMessage';
import { arxivProcessor } from '@latex/arxivProcessor';
import {
  extractBibliographyContext,
  loadBibliographyEntries,
} from '@latex/extractBibliography';
import { extractFigurePathsFromLatex } from '@latex/extractFigure';
import { extractLatexFileDependencies } from '@latex/extractFileDependencies';
import { LaTeXdiffService } from '@latex/latexdiff';
import { runLatexFormatter } from '@latex/texFormatter';
import { getTeXCount, TexcountModeSchema } from '@latex/texcount';
import { tikzPictureManager } from '@latex/TikzPictureManager';
import { pathToLocation } from '@utils/files';

import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import {
  writeNdjsonStdout,
  writeTextStderr,
  writeTextStdout,
} from '../runtime/logSinks';
import type { CliContext } from '../runtime/cliContext';
import type { ParsedGlobalArgs } from '../runtime/globalArgs';

const LatexDiffResultSchema = z.object({
  kind: z.literal('latex-diff'),
  oldFile: z.string(),
  newFile: z.string(),
  outputFile: z.string(),
});

const LatexCountSummarySchema = z.object({
  wordsInText: z.number().nullable(),
  wordsInHeaders: z.number().nullable(),
  wordsOutsideText: z.number().nullable(),
  totalWords: z.number().nullable(),
  sourceCharacters: z.number().nullable(),
});

const LatexCountResultSchema = z.object({
  kind: z.literal('latex-count'),
  files: z.array(z.string()),
  mode: TexcountModeSchema,
  summary: LatexCountSummarySchema,
  output: z.string().nullable(),
  errors: z.array(z.string()),
});

const LatexPathListResultSchema = z.object({
  kind: z.enum(['latex-figs', 'latex-deps', 'latex-tikz']),
  file: z.string(),
  paths: z.array(z.string()),
});

const LatexBibliographyResultSchema = z.object({
  kind: z.literal('latex-bib'),
  file: z.string(),
  bibliographyFiles: z.array(z.string()),
  missingBibliographyFiles: z.array(z.string()),
  citationKeys: z.array(z.string()),
  missingKeys: z.array(z.string()),
  entries: z.record(z.string(), z.string()),
});

const LatexFormatResultSchema = z.object({
  kind: z.literal('latex-fmt'),
  file: z.string(),
  formatted: z.boolean(),
});

const LatexArxivResultSchema = z.object({
  kind: z.literal('latex-arxiv'),
  id: z.string(),
  path: z.string(),
  alreadyExisted: z.boolean(),
});

export const LatexCliResultSchema = z.discriminatedUnion('kind', [
  LatexDiffResultSchema,
  LatexCountResultSchema,
  LatexPathListResultSchema,
  LatexBibliographyResultSchema,
  LatexFormatResultSchema,
  LatexArxivResultSchema,
]);

export type LatexCliResult = z.infer<typeof LatexCliResultSchema>;

type GlobalArgsDef = Record<string, unknown>;
const cliLatexdiffService = new LaTeXdiffService();

interface LatexCommandDependencies {
  readonly globalArgs: GlobalArgsDef;
  readonly contextFromArgs: (args: ParsedGlobalArgs) => Promise<CliContext>;
  readonly setExitCode: (code: number) => void;
}

function resolveCliPath(cwd: string, candidate: string): string {
  return path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(cwd, candidate);
}

function displayCliPath(cwd: string, candidate: string): string {
  const absolutePath = resolveCliPath(cwd, candidate);
  const relativePath = path.relative(cwd, absolutePath);
  if (
    relativePath &&
    !relativePath.startsWith('..') &&
    !path.isAbsolute(relativePath)
  ) {
    return relativePath.replaceAll(path.sep, '/');
  }
  return absolutePath;
}

async function initLatexCliPlatform(context: CliContext): Promise<void> {
  await initCliPlatform({
    ...context,
    quietLogs: true,
    skipIncludedModelAccess: true,
  });
}

async function assertReadableFile(filePath: string): Promise<void> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      throw new Error(`${filePath} is not a file.`);
    }
  } catch (error) {
    throw new Error(`Cannot read ${filePath}: ${toErrorMessage(error)}`);
  }
}

function parseTexcountNumber(output: string, label: string): number | null {
  const escaped = label.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `${escaped}(?:\\s*\\([^)]*\\))?:\\s*(\\d+)`,
    'i',
  ).exec(output);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function summarizeTexcountOutput(
  output: string | null,
): z.infer<typeof LatexCountSummarySchema> {
  if (!output) {
    return {
      wordsInText: null,
      wordsInHeaders: null,
      wordsOutsideText: null,
      totalWords: null,
      sourceCharacters: null,
    };
  }

  const wordsInText = parseTexcountNumber(output, 'Words in text');
  const wordsInHeaders = parseTexcountNumber(output, 'Words in headers');
  const wordsOutsideText = parseTexcountNumber(output, 'Words outside text');
  const parts = [wordsInText, wordsInHeaders, wordsOutsideText];
  const totalWords = parts.every((part) => part !== null)
    ? parts.reduce((sum, part) => sum + (part ?? 0), 0)
    : null;

  return {
    wordsInText,
    wordsInHeaders,
    wordsOutsideText,
    totalWords,
    sourceCharacters: null,
  };
}

function formatLatexCliResultText(result: LatexCliResult): string {
  switch (result.kind) {
    case 'latex-diff':
      return result.outputFile;
    case 'latex-count': {
      const total =
        result.summary.totalWords === null
          ? 'unknown'
          : String(result.summary.totalWords);
      const body = result.output ?? 'No texcount output.';
      const characters =
        result.summary.sourceCharacters === null
          ? 'unknown'
          : String(result.summary.sourceCharacters);
      const errors = result.errors.length
        ? `\n\nWarnings:\n${result.errors.join('\n')}`
        : '';
      return `Total words: ${total}\nSource characters: ${characters}\n\n${body}${errors}`;
    }
    case 'latex-figs':
    case 'latex-deps':
    case 'latex-tikz':
      return result.paths.length ? result.paths.join('\n') : 'No files found.';
    case 'latex-bib': {
      const entries = Object.values(result.entries);
      const sections = [
        result.bibliographyFiles.length
          ? `Bibliography files:\n${result.bibliographyFiles.join('\n')}`
          : 'Bibliography files: none',
        result.citationKeys.length
          ? `Citation keys:\n${result.citationKeys.join('\n')}`
          : 'Citation keys: none',
        entries.length ? `Entries:\n${entries.join('\n\n')}` : 'Entries: none',
      ];
      if (result.missingBibliographyFiles.length) {
        sections.push(
          `Missing bibliography files:\n${result.missingBibliographyFiles.join('\n')}`,
        );
      }
      if (result.missingKeys.length) {
        sections.push(
          `Missing citation keys:\n${result.missingKeys.join('\n')}`,
        );
      }
      return sections.join('\n\n');
    }
    case 'latex-fmt':
      return result.formatted
        ? `Formatted ${result.file}.`
        : `Could not format ${result.file}.`;
    case 'latex-arxiv':
      return result.alreadyExisted
        ? `Already downloaded: ${result.path}`
        : result.path;
  }
}

function writeLatexCliResult(
  context: CliContext,
  result: LatexCliResult,
): void {
  const parsed = LatexCliResultSchema.parse(result);
  if (context.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(parsed, null, 2));
  } else if (context.outputFormat === 'ndjson') {
    writeNdjsonStdout({
      kind: 'latex-result',
      ts: new Date().toISOString(),
      result: parsed,
    });
  } else {
    writeTextStdout(formatLatexCliResultText(parsed));
  }
}

async function runLatexAction(
  deps: LatexCommandDependencies,
  args: unknown,
  action: (context: CliContext) => Promise<LatexCliResult>,
): Promise<void> {
  const context = await deps.contextFromArgs(args as ParsedGlobalArgs);
  try {
    await initLatexCliPlatform(context);
    const result = await action(context);
    writeLatexCliResult(context, result);
    deps.setExitCode(CliExitCode.Success);
  } catch (error) {
    writeTextStderr(toErrorMessage(error));
    deps.setExitCode(CliExitCode.AgentError);
  }
}

async function runLatexDiff(
  context: CliContext,
  oldFile: string,
  newFile: string,
  outputFile?: string,
): Promise<LatexCliResult> {
  const oldPath = resolveCliPath(context.cwd, oldFile);
  const newPath = resolveCliPath(context.cwd, newFile);
  await Promise.all([assertReadableFile(oldPath), assertReadableFile(newPath)]);

  const requestedOutputPath = outputFile
    ? resolveCliPath(context.cwd, outputFile)
    : undefined;
  const outputDirectory = requestedOutputPath
    ? path.dirname(requestedOutputPath)
    : path.dirname(newPath);
  const result = await cliLatexdiffService.runDiff(
    pathToLocation(oldPath),
    pathToLocation(newPath),
    '_diff',
    false,
    undefined,
    { cwd: context.cwd, outputDirectory },
  );
  if (!result.success || !result.diffFileName) {
    throw new Error(result.message || 'latexdiff failed.');
  }

  const generatedPath = path.join(outputDirectory, result.diffFileName);
  const finalPath = requestedOutputPath ?? generatedPath;
  if (path.resolve(generatedPath) !== path.resolve(finalPath)) {
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.rename(generatedPath, finalPath);
  }

  return {
    kind: 'latex-diff',
    oldFile: displayCliPath(context.cwd, oldPath),
    newFile: displayCliPath(context.cwd, newPath),
    outputFile: displayCliPath(context.cwd, finalPath),
  };
}

async function runLatexCount(
  context: CliContext,
  file: string,
  mode: unknown,
): Promise<LatexCliResult> {
  const parsedMode = TexcountModeSchema.catch('separate').parse(mode);
  const filePath = resolveCliPath(context.cwd, file);
  const result = await getTeXCount(filePath, {
    mode: parsedMode,
    channel: 'LaTeXCommands',
  });
  if (!result.output) {
    throw new Error(
      result.errors.join('\n') ||
        'texcount produced no output. Check that texcount is installed.',
    );
  }
  return {
    kind: 'latex-count',
    files: [displayCliPath(context.cwd, filePath)],
    mode: parsedMode,
    summary: {
      ...summarizeTexcountOutput(result.output),
      sourceCharacters: (await fs.readFile(filePath, 'utf8')).length,
    },
    output: result.output,
    errors: result.errors,
  };
}

async function runLatexArxiv(
  context: CliContext,
  id: string,
  into?: string,
): Promise<LatexCliResult> {
  const result = await arxivProcessor.downloadSource(id, {
    autoIndent: false,
    ...(into ? { into } : {}),
  });
  return {
    kind: 'latex-arxiv',
    id,
    path: displayCliPath(context.cwd, result.path),
    alreadyExisted: result.alreadyExisted,
  };
}

async function runLatexFigures(
  context: CliContext,
  file: string,
): Promise<LatexCliResult> {
  const filePath = resolveCliPath(context.cwd, file);
  await assertReadableFile(filePath);
  const paths = await extractFigurePathsFromLatex(pathToLocation(filePath));
  return {
    kind: 'latex-figs',
    file: displayCliPath(context.cwd, filePath),
    paths,
  };
}

async function runLatexDependencies(
  context: CliContext,
  file: string,
): Promise<LatexCliResult> {
  const filePath = resolveCliPath(context.cwd, file);
  await assertReadableFile(filePath);
  const paths = await extractLatexFileDependencies(pathToLocation(filePath));
  return {
    kind: 'latex-deps',
    file: displayCliPath(context.cwd, filePath),
    paths: paths.map((p) => displayCliPath(context.cwd, p)),
  };
}

async function runLatexBibliography(
  context: CliContext,
  file: string,
): Promise<LatexCliResult> {
  const filePath = resolveCliPath(context.cwd, file);
  await assertReadableFile(filePath);
  const reference = await extractBibliographyContext(
    displayCliPath(context.cwd, filePath),
  );
  const entries = await loadBibliographyEntries(
    reference.bibliographyFiles,
    reference.citationKeys,
  );
  return {
    kind: 'latex-bib',
    file: displayCliPath(context.cwd, filePath),
    bibliographyFiles: reference.bibliographyFiles,
    missingBibliographyFiles: reference.missingBibliographyFiles,
    citationKeys: reference.citationKeys,
    missingKeys: entries.missingKeys,
    entries: Object.fromEntries(entries.entries),
  };
}

async function runLatexFormat(
  context: CliContext,
  file: string,
): Promise<LatexCliResult> {
  const filePath = resolveCliPath(context.cwd, file);
  await assertReadableFile(filePath);
  const formatted = await runLatexFormatter(filePath);
  if (!formatted) {
    throw new Error(
      'Formatter failed. Check that latexindent or tex-fmt is installed and configured.',
    );
  }
  return {
    kind: 'latex-fmt',
    file: displayCliPath(context.cwd, filePath),
    formatted,
  };
}

async function runLatexTikz(
  context: CliContext,
  file: string,
): Promise<LatexCliResult> {
  const filePath = resolveCliPath(context.cwd, file);
  await assertReadableFile(filePath);
  const compiled = await tikzPictureManager.compile(pathToLocation(filePath));
  return {
    kind: 'latex-tikz',
    file: displayCliPath(context.cwd, filePath),
    paths: compiled.map((location) =>
      displayCliPath(context.cwd, location.absolutePath),
    ),
  };
}

export function createLatexCommand(deps: LatexCommandDependencies) {
  const globalArgs = deps.globalArgs;

  const diff = defineCommand({
    meta: { name: 'diff', description: 'Run latexdiff on two LaTeX files' },
    args: {
      ...globalArgs,
      old: { type: 'positional', required: true, description: 'Old .tex file' },
      new: { type: 'positional', required: true, description: 'New .tex file' },
      out: { type: 'string', description: 'Output diff .tex file' },
    },
    async run(ctx) {
      await runLatexAction(deps, ctx.args, (context) =>
        runLatexDiff(context, ctx.args.old, ctx.args.new, ctx.args.out),
      );
    },
  });

  const count = defineCommand({
    meta: { name: 'count', description: 'Run texcount on a LaTeX file' },
    args: {
      ...globalArgs,
      file: { type: 'positional', required: true, description: 'LaTeX file' },
      mode: {
        type: 'enum',
        options: TexcountModeSchema.options,
        description: 'texcount mode',
      },
    },
    async run(ctx) {
      await runLatexAction(deps, ctx.args, (context) =>
        runLatexCount(context, ctx.args.file, ctx.args.mode),
      );
    },
  });

  const arxiv = defineCommand({
    meta: { name: 'arxiv', description: 'Download arXiv source files' },
    args: {
      ...globalArgs,
      id: {
        type: 'positional',
        required: true,
        description: 'arXiv id or URL',
      },
      into: {
        type: 'string',
        description: 'Workspace-relative destination directory',
      },
    },
    async run(ctx) {
      await runLatexAction(deps, ctx.args, (context) =>
        runLatexArxiv(context, ctx.args.id, ctx.args.into),
      );
    },
  });

  const figs = defineCommand({
    meta: {
      name: 'figs',
      description: 'List figures referenced by a LaTeX file',
    },
    args: {
      ...globalArgs,
      file: { type: 'positional', required: true, description: 'LaTeX file' },
    },
    async run(ctx) {
      await runLatexAction(deps, ctx.args, (context) =>
        runLatexFigures(context, ctx.args.file),
      );
    },
  });

  const depsCommand = defineCommand({
    meta: {
      name: 'deps',
      description: 'List LaTeX input and bibliography dependencies',
    },
    args: {
      ...globalArgs,
      file: { type: 'positional', required: true, description: 'LaTeX file' },
    },
    async run(ctx) {
      await runLatexAction(deps, ctx.args, (context) =>
        runLatexDependencies(context, ctx.args.file),
      );
    },
  });

  const bib = defineCommand({
    meta: {
      name: 'bib',
      description: 'Extract bibliography context for a LaTeX file',
    },
    args: {
      ...globalArgs,
      file: { type: 'positional', required: true, description: 'LaTeX file' },
    },
    async run(ctx) {
      await runLatexAction(deps, ctx.args, (context) =>
        runLatexBibliography(context, ctx.args.file),
      );
    },
  });

  const fmt = defineCommand({
    meta: { name: 'fmt', description: 'Format a LaTeX file' },
    args: {
      ...globalArgs,
      file: { type: 'positional', required: true, description: 'LaTeX file' },
    },
    async run(ctx) {
      await runLatexAction(deps, ctx.args, (context) =>
        runLatexFormat(context, ctx.args.file),
      );
    },
  });

  const tikz = defineCommand({
    meta: { name: 'tikz', description: 'Extract and compile TikZ pictures' },
    args: {
      ...globalArgs,
      file: { type: 'positional', required: true, description: 'LaTeX file' },
    },
    async run(ctx) {
      await runLatexAction(deps, ctx.args, (context) =>
        runLatexTikz(context, ctx.args.file),
      );
    },
  });

  return defineCommand({
    meta: { name: 'latex', description: 'LaTeX utilities' },
    subCommands: {
      diff,
      count,
      arxiv,
      figs,
      deps: depsCommand,
      bib,
      fmt,
      tikz,
    },
  });
}
