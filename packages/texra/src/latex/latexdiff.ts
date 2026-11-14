/**
 * latexdiff and latexdiff-vc: one run of the tool over a pair of documents (or
 * a document against a commit), its `--flatten` fallback, and the clean-up of
 * the file it writes. A run succeeds with the diff's absolute path and fails
 * with a typed error each caller reports in its own words: the tool failed
 * ({@link LatexdiffFailed}), is not installed (`ToolMissing`), or an input is
 * no whole document ({@link NoDocumentEnvironment}).
 */

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Schema } from 'effect';

// Local imports
import { redactSecrets } from '@texra-ai/harness/host';
import { Settings } from '@texra-ai/harness/plugins';
import { readNormalizedFile } from '@texra-ai/harness/node';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { FileLocation } from '@texra-ai/harness/schemas';
import { DISPLAY_MATH_ENVIRONMENTS } from '@replacement/constants';
import replacementEngine, {
  logReplacementDiagnostics,
} from '@replacement/engine';
import type { LatexdiffMathMarkupValue } from '@texra/shared/constants/latexConfig';
import { repositoryRoot } from '@texra/utils/git/gitReads';
import { runTool } from '@texra/utils/system/toolChecks';

// Local file imports
import { LATEX_CITATION_COMMANDS } from './latexParsingUtils';
import {
  generateDiffFileName,
  versionControlDiffStem,
} from './latexdiff/diffFileNameManager';
import {
  LATEXDIFF_CHANGES_ONLY_SETTING,
  LATEXDIFF_MATH_MARKUP_SETTING,
  LATEXDIFF_TIMEOUT_SETTING,
} from '@texra/shared/settings/documentsSettings';

/** One latexdiff or latexdiff-vc run that did not succeed. Its `stderr` is
 *  scrubbed of secrets on the way in: a run writes the message verbatim into
 *  its transcript's documents fact. */
class LatexdiffFailed extends Schema.TaggedError<LatexdiffFailed>()(
  'LatexdiffFailed',
  {
    commandType: Schema.String,
    flatten: Schema.Boolean,
    timedOut: Schema.Boolean,
    timeoutMs: Schema.Number,
    stderr: Schema.String,
  },
) {
  override get message(): string {
    const variant = this.flatten ? '' : ' (without --flatten)';
    if (this.timedOut) {
      return `${this.commandType} operation timed out after ${this.timeoutMs}ms${variant}`;
    }
    return this.stderr
      ? `Failed to run ${this.commandType}${variant}: ${this.stderr}`
      : `Failed to run ${this.commandType}${variant}`;
  }
}

/** An input without `\begin{document}` and `\end{document}`: latexdiff has
 *  nothing to mark up, so a run's pass records it at debug level. */
class NoDocumentEnvironment extends Schema.TaggedError<NoDocumentEnvironment>()(
  'NoDocumentEnvironment',
  { file: Schema.String },
) {
  override get message(): string {
    return `${this.file} has no document environment (\\begin{document} … \\end{document})`;
  }
}

const LATEXDIFF_PICTURE_ENVIRONMENTS =
  '(?:picture|tikzpicture|scope|DIFnomarkup)[\\w\\d*@]*';

const BIBLIOGRAPHY_ERROR_PATTERNS = [
  'bibtex',
  'Something went wrong in executing',
  'latex -draftmode',
  'Running bibtex to generate',
] as const;

/**
 * `--exclude-textcmd` argument: every citation macro, starred forms included,
 * whose argument latexdiff must leave alone instead of marking up as prose.
 */
const LATEXDIFF_CITATION_TEXT_COMMAND_EXCLUSIONS: readonly string[] =
  Object.freeze(LATEX_CITATION_COMMANDS.map((name) => `${name}\\*?`));

const LATEXDIFF_CHANGES_ONLY_SUBTYPE = 'ONLYCHANGEDPAGE';

/** How a diff marks changes; a field left out is the workspace's setting. */
interface MarkupOptions {
  readonly mathMarkup?: LatexdiffMathMarkupValue;
  /** Change boundary marking, e.g. `ONLYCHANGEDPAGE`. */
  readonly subtype?: string;
}

/** The markup flags latexdiff and latexdiff-vc share. */
const markupFlags = Effect.fn('latexdiff.markupFlags')(function* (
  roots: WorkspaceRoots,
  options: MarkupOptions,
) {
  const mathMarkup =
    options.mathMarkup ??
    (yield* Settings.get(roots, LATEXDIFF_MATH_MARKUP_SETTING));
  const changesOnly = yield* Settings.get(
    roots,
    LATEXDIFF_CHANGES_ONLY_SETTING,
  );
  const subtype =
    options.subtype ??
    (changesOnly ? LATEXDIFF_CHANGES_ONLY_SUBTYPE : undefined);
  return [
    '--graphics-markup=none',
    `--exclude-textcmd=${LATEXDIFF_CITATION_TEXT_COMMAND_EXCLUSIONS.join(',')}`,
    `--math-markup=${mathMarkup}`,
    ...(subtype ? [`--subtype=${subtype}`] : []),
  ];
});

const isBibliographyError = (error: LatexdiffFailed): boolean =>
  !error.timedOut &&
  BIBLIOGRAPHY_ERROR_PATTERNS.every((pattern) =>
    error.stderr.includes(pattern),
  );

/**
 * Run `tool` with the arguments `args(true)` builds, and on a bibliography
 * failure again without `--flatten`. The subprocess is torn down by the
 * fiber's own interruption: `executeCommand` kills it from its finalizer.
 * Succeeds with the tool's stdout.
 */
const runWithFlattenFallback = Effect.fn('latexdiff.runWithFlattenFallback')(
  function* (
    tool: 'latexdiff' | 'latexdiff-vc',
    args: (flatten: boolean) => readonly string[],
    roots: WorkspaceRoots,
    cwd: string | undefined,
  ) {
    // Read once, so the --flatten attempt and its retry share one deadline.
    const timeoutMs = yield* Settings.get(roots, LATEXDIFF_TIMEOUT_SETTING);
    const attempt = Effect.fn('latexdiff.attempt')(function* (
      flatten: boolean,
    ) {
      yield* Effect.logDebug(
        `Running ${tool} ${flatten ? 'with' : 'without'} --flatten`,
      );
      const result = yield* runTool(tool, args(flatten), {
        timeout: timeoutMs,
        cwd,
      });
      if (!result.success || !result.stdout) {
        return yield* new LatexdiffFailed({
          commandType: tool,
          flatten,
          timedOut: result.timedOut,
          timeoutMs,
          stderr: redactSecrets(
            result.success ? 'it produced no output' : result.stderr,
          ),
        });
      }
      return result.stdout;
    });
    return yield* attempt(true).pipe(
      Effect.catchIf(
        (error) =>
          error instanceof LatexdiffFailed && isBibliographyError(error),
        () =>
          Effect.logWarning(
            'Bibliography compilation failed with --flatten, retrying without --flatten',
          ).pipe(Effect.andThen(attempt(false))),
      ),
    );
  },
);

const requireDocument = Effect.fn('latexdiff.requireDocument')(function* (
  file: string,
  content: string,
) {
  if (
    !content.includes('\\begin{document}') ||
    !content.includes('\\end{document}')
  ) {
    return yield* new NoDocumentEnvironment({ file });
  }
});

/** Where a latexdiff runs and what it writes. */
interface LatexdiffOptions extends MarkupOptions {
  /** The roots of the workspace being diffed: its settings and replacement
   *  rules answer for the diff, never the calling fiber's. */
  readonly roots: WorkspaceRoots;
  /** Directory latexdiff runs in, named by the caller from the roots it
   *  holds (#12421). */
  readonly cwd: string | undefined;
  /** What the diff file's name adds to the revised file's stem. */
  readonly suffix: string;
  /** Where the diff is written; the base's folder when left out. */
  readonly outputDirectory?: string;
}

/**
 * latexdiff of `revised` against `base`, cleaned up for compiling: the
 * absolute path of the diff `.tex` it wrote. Only this function picks the
 * output directory, so a caller never re-joins a file name of its own.
 */
export const latexdiff = Effect.fn('latexdiff')(function* (
  base: FileLocation,
  revised: FileLocation,
  options: LatexdiffOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const [baseContent, revisedContent] = yield* Effect.all(
    [
      readNormalizedFile(fs, base.absolutePath),
      readNormalizedFile(fs, revised.absolutePath),
    ],
    { concurrency: 2 },
  );
  yield* requireDocument(base.absolutePath, baseContent);
  yield* requireDocument(revised.absolutePath, revisedContent);

  const flags = yield* markupFlags(options.roots, options);
  const stdout = yield* runWithFlattenFallback(
    'latexdiff',
    (flatten) => [
      ...(flatten ? ['--flatten'] : []),
      '--encoding=utf8',
      '-c',
      `PICTUREENV=${LATEXDIFF_PICTURE_ENVIRONMENTS}`,
      ...flags,
      base.absolutePath,
      revised.absolutePath,
    ],
    options.roots,
    options.cwd,
  );

  const outputDirectory =
    options.outputDirectory ?? path.dirname(base.absolutePath);
  const diffPath = path.join(
    outputDirectory,
    generateDiffFileName(revised.absolutePath, options.suffix),
  );
  yield* fs.makeDirectory(outputDirectory, { recursive: true });
  yield* fs.writeFileString(
    diffPath,
    yield* cleanDiff(stdout, revisedContent, options.roots),
  );
  yield* Effect.logDebug(
    `latexdiff wrote ${diffPath} for ${base.absolutePath} -> ${revised.absolutePath}`,
  );
  return diffPath;
});

/**
 * latexdiff-vc of `input` against `commit`: the absolute path of the diff
 * it wrote beside the input.
 */
export const latexdiffAgainstCommit = Effect.fn('latexdiffAgainstCommit')(
  function* (input: FileLocation, commit: string, roots: WorkspaceRoots) {
    const fs = yield* FileSystem.FileSystem;
    const inputFile = input.absolutePath;
    const content = yield* readNormalizedFile(fs, inputFile);
    yield* requireDocument(inputFile, content);

    // latexdiff-vc --git runs `git show <commit>:<file>`, which expects a
    // path relative to the repository root; an absolute path breaks its temp
    // path construction.
    const fileDir = path.dirname(inputFile);
    const gitRoot = yield* repositoryRoot(fileDir);
    const cwd = gitRoot ?? fileDir;
    const filePath = gitRoot
      ? path.relative(gitRoot, inputFile)
      : path.basename(inputFile);

    const flags = yield* markupFlags(roots, {});
    yield* runWithFlattenFallback(
      'latexdiff-vc',
      (flatten) => [
        '--encoding=utf8',
        '-c',
        `PICTUREENV=${LATEXDIFF_PICTURE_ENVIRONMENTS}`,
        '--force',
        ...(flatten ? ['--flatten'] : []),
        '--git',
        ...flags,
        '-r',
        commit,
        filePath,
      ],
      roots,
      cwd,
    );

    // latexdiff-vc writes beside the input, relative to cwd, inserting
    // `-diff<hash>` before the extension. Anchor the insertion to the parsed
    // extension: a plain `.tex` replacement would land on the first `.tex`
    // anywhere in the path, so a directory such as `my.texnotes/` would send
    // us looking for a file that was never written.
    const parsed = path.parse(filePath);
    const diffPath = path.join(
      cwd,
      parsed.dir,
      `${versionControlDiffStem(parsed.name, commit)}${parsed.ext}`,
    );
    const diffContent = yield* readNormalizedFile(fs, diffPath);
    yield* fs.writeFileString(
      diffPath,
      yield* cleanDiff(diffContent, content, roots),
    );
    return diffPath;
  },
);

// The clean-up of latexdiff's output: pure text transforms, then the
// workspace's replacement rules.

/** The starred (unnumbered) display environments, whose labels are removed. */
const STAR_ENV_REGEX = new RegExp(
  `\\\\begin\\{(${DISPLAY_MATH_ENVIRONMENTS.map((name) => `${name}\\*`).join('|')})\\}([\\s\\S]*?)\\\\end\\{\\1\\}`,
  'g',
);

/** Substrings that trigger extra newlines before the line for readability. */
const PACKAGES_NEEDING_NEWLINE = [
  '\\usepackage{tikz}',
  '\\usepackage{pgfplots}',
  '\\providecommand{\\DIFaddbegin}',
  '\\RequirePackage[normalem]{ulem}',
  '\\usetikzlibrary',
  '\\RequirePackage{color}',
] as const;

/** Pattern to match TEX root comments (handles various spacing: %!TEX, % !TEX, %! TEX). */
const TEX_ROOT_COMMENT = /^%\s?!\s?TEX root/;

/** Markers that indicate start of preamble content to skip (before document starts). */
const PREAMBLE_SKIP_MARKERS = ['%DIF ADD', 'Here is', '以下是'];

/** Markers that indicate document structure has begun. */
const DOCUMENT_START_MARKERS = ['\\documentclass', '\\input'];

/** Patterns to fix broken document endings after latexdiff processing. */
const DOCUMENT_END_FIXES: [RegExp, string][] = [
  [/\\end\{document\}\s*\\chapter/g, '\\chapter'],
  [/\\end\{document\}\s*\\addcontentsline/g, '\\addcontentsline'],
];

/** Flattened .bbl blocks can contain macro definitions that latexdiff corrupts. */
const THEBIBLIOGRAPHY_BLOCK =
  /\\begin\{thebibliography\}\{[^}]*\}[\s\S]*?\\end\{thebibliography\}/g;

/** The real bibliography entries start here; only sanitize generated macros before it. */
const BIBITEM_START = /(?:^|\n)\s*(?:\\DIF(?:add|del)\{)?\\bibitem\b/;

/** latexdiff's output made compilable: the edited document's
 *  `\bibliography` restored over a flattened one, starred environments
 *  without labels, the preamble chatter dropped, the replacement rules
 *  applied. */
const cleanDiff = Effect.fn('latexdiff.cleanDiff')(function* (
  content: string,
  editedContent: string,
  roots: WorkspaceRoots,
) {
  let processed = restoreFlattenedBibliography(content, editedContent);
  processed = processStarEnvironments(processed);
  processed = processLineByLine(processed);
  const replaced = replacementEngine.applyAll(processed, roots.config);
  yield* logReplacementDiagnostics(replaced.diagnostics);
  processed = replaced.text;
  for (const [pattern, replacement] of DOCUMENT_END_FIXES) {
    processed = processed.replace(pattern, replacement);
  }
  return processed;
});

function restoreFlattenedBibliography(
  content: string,
  editedContent: string,
): string {
  // First \bibliography directive on a non-comment line.
  const bibliography = editedContent.match(
    /^(?![^\S\r\n]*%).*?(\\bibliography\s*\{[^}]+\})/m,
  )?.[1];
  if (!bibliography) {
    return sanitizeFlattenedBibliographyMacroPreamble(content);
  }
  return content.replaceAll(THEBIBLIOGRAPHY_BLOCK, bibliography);
}

function sanitizeFlattenedBibliographyMacroPreamble(content: string): string {
  return content.replaceAll(THEBIBLIOGRAPHY_BLOCK, (block) => {
    const bibitemStart = BIBITEM_START.exec(block);
    const preambleEnd = bibitemStart?.index ?? block.length;
    const preamble = block.slice(0, preambleEnd);
    if (!preamble.includes('\\DIFadd') && !preamble.includes('\\DIFdel')) {
      return block;
    }
    return (
      stripLatexdiffMarkupFromMacroPreamble(preamble) + block.slice(preambleEnd)
    );
  });
}

function stripLatexdiffMarkupFromMacroPreamble(content: string): string {
  let sanitized = content
    .replaceAll(/%DIF\s*>/g, '%')
    .replaceAll(
      /\\DIF(?:add|del)\{\\mbox\{%DIFAUXCMD\s*\r?\n\\([A-Za-z@]+)\s*\}\\hskip0pt%DIFAUXCMD\s*\r?\n\}/g,
      '\\$1 ',
    );

  let previous: string;
  do {
    previous = sanitized;
    sanitized = sanitized.replaceAll(/\\DIF(?:add|del)\{([^{}]*)\}/g, '$1');
  } while (sanitized !== previous);

  return sanitized;
}

function processStarEnvironments(content: string): string {
  return content.replaceAll(STAR_ENV_REGEX, (_match, envName, envContent) => {
    const cleanContent = envContent.replaceAll(/\\label\{[^}]*\}/g, '');
    return `\\begin{${envName}}${cleanContent}\\end{${envName}}`;
  });
}

function processLineByLine(content: string): string {
  let skippingPreambleBlock = false;
  let documentStarted = false;

  const processedLines = content.split('\n').flatMap((line) => {
    if (TEX_ROOT_COMMENT.test(line)) {
      return [];
    }

    if (DOCUMENT_START_MARKERS.some((marker) => line.includes(marker))) {
      documentStarted = true;
      skippingPreambleBlock = false;
    } else if (
      !documentStarted &&
      PREAMBLE_SKIP_MARKERS.some((marker) => line.includes(marker))
    ) {
      skippingPreambleBlock = true;
    }

    if (skippingPreambleBlock) {
      return [];
    }

    const result: string[] = [];
    if (PACKAGES_NEEDING_NEWLINE.some((pkg) => line.includes(pkg))) {
      result.push('');
    }
    result.push(line);
    if (line.includes('\\RequirePackage{color}')) {
      result.push('');
    }
    return result;
  });

  return processedLines.join('\n') + '\n';
}
