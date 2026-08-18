/**
 * Filename-header document recovery for fallback output extraction.
 *
 * Splits a raw model response into named documents by recognizing
 * `% path/file.ext` comment headers and bare known-file labels, handling
 * markdown fences around each document and the ambiguity of `%` headers
 * that are really LaTeX comments.
 */

import * as path from 'node:path';

import escapeRegExp from 'escape-string-regexp';

import { getBasename, normalizeFilePath } from '@utils/core';
import {
  getExtractedDocOutputFileName,
  getSafeDocumentRelativePath,
} from '@utils/files/outputFileUtils';

import {
  isClosingMarkdownFence,
  isLatexMarkdownFence,
  type MarkdownFence,
  parseMarkdownFenceDelimiter,
  responseLines,
  stripFirstLastLineIfWrapped,
  stripSurroundingMarkdownFence,
} from './contentSimilarity';

// ---------------------------------------------------------------------------
// latexHeuristics
// ---------------------------------------------------------------------------

/**
 * LaTeX-shape heuristics for fallback output extraction.
 *
 * Answers structural questions about candidate lines without parsing LaTeX:
 * whether text sits inside a \begin{document} body or a preamble, whether a
 * filename header line doubles as a real LaTeX comment, and whether a block
 * of lines looks like LaTeX content at all.
 */

const LATEX_DOCUMENTCLASS_REGEX = /\\documentclass\b/;
const LATEX_DOCUMENT_BEGIN_REGEX = /\\begin\s*\{\s*document\s*\}/;
const LATEX_DOCUMENT_END_REGEX = /\\end\s*\{\s*document\s*\}/;
const LIKELY_LATEX_CONTENT_REGEX =
  /^\\(?:chapter|section|subsection|subsubsection|paragraph|begin|end|input|include|documentclass|usepackage|newcommand|renewcommand|[([])/;

function getLatexDocumentContext(lines: readonly string[]): {
  insideDocumentBody: boolean;
  inDocumentPreamble: boolean;
} {
  let depth = 0;
  let sawDocumentclassWithoutBody = false;
  for (const line of lines) {
    if (line.trim().startsWith('%')) {
      continue;
    }
    if (LATEX_DOCUMENTCLASS_REGEX.test(line)) {
      sawDocumentclassWithoutBody = true;
    }
    if (LATEX_DOCUMENT_BEGIN_REGEX.test(line)) {
      depth += 1;
      sawDocumentclassWithoutBody = false;
    }
    if (LATEX_DOCUMENT_END_REGEX.test(line) && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        sawDocumentclassWithoutBody = false;
      }
    }
  }
  return {
    insideDocumentBody: depth > 0,
    inDocumentPreamble: sawDocumentclassWithoutBody,
  };
}

function hasDocumentBeginInCurrentPreamble(
  lines: readonly string[],
  startIndex: number,
): boolean {
  for (const line of lines.slice(startIndex + 1)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('%')) {
      continue;
    }
    if (LATEX_DOCUMENTCLASS_REGEX.test(line)) {
      return false;
    }
    if (LATEX_DOCUMENT_BEGIN_REGEX.test(line)) {
      return true;
    }
  }
  return false;
}

function shouldKeepPercentHeaderAsLatexComment(
  linesBeforeHeader: readonly string[],
  allLines: readonly string[],
  headerIndex: number,
): boolean {
  const context = getLatexDocumentContext(linesBeforeHeader);
  if (context.insideDocumentBody) {
    return true;
  }
  return (
    context.inDocumentPreamble &&
    hasDocumentBeginInCurrentPreamble(allLines, headerIndex)
  );
}

function hasLikelyLatexContent(lines: readonly string[]): boolean {
  return lines.some((line) => LIKELY_LATEX_CONTENT_REGEX.test(line.trim()));
}

const LITERAL_ENV_BOUNDARY_REGEX =
  /\\(begin|end)\s*\{\s*(?:verbatim\*?|lstlisting|minted|Verbatim)\s*\}/g;

/**
 * Whether the last of these lines sits inside an unclosed verbatim-style
 * environment, whose content is literal text — a filename-looking line
 * there is part of the listing, not a document header.
 */
function isInsideLiteralEnvironment(lines: readonly string[]): boolean {
  let depth = 0;
  for (const line of lines) {
    for (const match of line.matchAll(LITERAL_ENV_BOUNDARY_REGEX)) {
      if (match[1] === 'begin') {
        depth += 1;
      } else if (depth > 0) {
        depth -= 1;
      }
    }
  }
  return depth > 0;
}

// ---------------------------------------------------------------------------
// filenameHeaders
// ---------------------------------------------------------------------------

const PERCENT_FILENAME_HEADER_REGEX =
  /^%\s+((?:\.[/\\])*[A-Za-z0-9_][A-Za-z0-9._/\\-]*\.[A-Za-z0-9]+)\s*$/;
/** Trailing label punctuation after a bare filename (`Draft3.tex:`). */
const TRAILING_COLON_REGEX = /:+$/;
/** Markdown decoration that is never part of a filename (`**x**`, `` `x` ``). */
const SAFE_DECORATION_REGEX = /^[*`]+|[*`:]+$/g;
/** Strip trailing emphasis without stripping a filename's leading underscore. */
const TRAILING_EMPHASIS_DECORATION_REGEX = /^[*`]+|[*_`:]+$/g;
/** Full decoration strip, including emphasis underscores (`_x_`). */
const FULL_DECORATION_REGEX = /^[*_`]+|[*_`:]+$/g;
const FILE_LIKE_LABEL_REGEX =
  /^\s*(?:\.[/\\])*[A-Za-z0-9_][A-Za-z0-9._/\\-]*\.[A-Za-z0-9]+:+\s*$/;

/**
 * Canonical form for comparing a model-reported document name against a
 * known file: forward slashes, no leading `./` segments.
 */
export function normalizeDocumentName(name: string): string {
  return normalizeFilePath(name).replace(/^(?:\.\/)+/, '');
}

function matchNormalizedCandidate(
  stripped: string,
  knownFiles: readonly string[],
): string | null {
  if (!stripped) return null;
  const candidate = normalizeDocumentName(stripped);
  const exact = knownFiles.find((f) => normalizeFilePath(f) === candidate);
  if (exact) return exact;

  // Fall back to a basename match when the model dropped the leading
  // directories, but only when it resolves unambiguously.
  const basenameMatches = knownFiles.filter(
    (f) => getBasename(f) === candidate,
  );
  return basenameMatches.length === 1 ? basenameMatches[0] : null;
}

/**
 * Recognize a header line that names one of the agent's known files directly,
 * without the `%` comment prefix (e.g. `Draft/Draft3.tex:` or
 * `**Draft3.tex**`). Unlike the percent-header form, a bare line like this is
 * never valid LaTeX on its own, so the only ambiguity risk is a coincidental
 * match — guarded against by only ever matching against the agent's own
 * known files rather than any path-shaped string.
 *
 * Decoration is stripped progressively because an underscore is both markdown
 * emphasis and a legal filename character: `_macros.tex:` must keep its
 * underscore, while `_paper.tex_` must lose both.
 */
function matchKnownFileLabel(
  line: string,
  knownFiles: readonly string[],
): string | null {
  const trimmed = line.trim();
  for (const stripped of [
    trimmed.replace(TRAILING_COLON_REGEX, ''),
    trimmed.replaceAll(SAFE_DECORATION_REGEX, ''),
    trimmed.replaceAll(TRAILING_EMPHASIS_DECORATION_REGEX, ''),
    trimmed.replaceAll(FULL_DECORATION_REGEX, ''),
  ]) {
    const match = matchNormalizedCandidate(stripped, knownFiles);
    if (match) return match;
  }
  return null;
}

function makeUniquePercentHeaderName(
  source: string,
  reservedFinalPaths: Set<string>,
  roundDir: string,
): string {
  const safeName = safeDocumentName(source);
  let candidate = safeName;
  let suffix = 2;

  const finalPathKey = (name: string) =>
    getExtractedDocOutputFileName(name, roundDir).replaceAll('\\', '/');

  while (reservedFinalPaths.has(finalPathKey(candidate))) {
    const parsed = path.posix.parse(safeName);
    candidate = path.posix.join(
      parsed.dir,
      `${parsed.name}-${suffix}${parsed.ext}`,
    );
    suffix += 1;
  }

  reservedFinalPaths.add(finalPathKey(candidate));
  return candidate;
}

function safeDocumentName(source: string): string {
  return getSafeDocumentRelativePath(source);
}

function stripDocumentsEnvelope(
  lines: readonly string[],
  wrapperTag: string,
): string[] {
  const trimmedTag = wrapperTag.trim();
  if (!trimmedTag) return [...lines];
  const openRegex = new RegExp(
    `^<${escapeRegExp(trimmedTag)}\\b[^>]*>\\s*$`,
    'i',
  );
  const closeRegex = new RegExp(`^<\\/${escapeRegExp(trimmedTag)}>\\s*$`, 'i');
  return stripFirstLastLineIfWrapped(
    lines,
    (line) => openRegex.test(line.trim()),
    (_openLine, line) => closeRegex.test(line.trim()),
  );
}

function matchHeaderName(
  line: string,
  labelFiles: readonly string[],
): string | null {
  return (
    PERCENT_FILENAME_HEADER_REGEX.exec(line.trim())?.[1] ??
    matchKnownFileLabel(line, labelFiles)
  );
}

function findClosingFenceIndex(
  lines: readonly string[],
  startIndex: number,
  openingFence: MarkdownFence,
): number {
  return lines.findIndex(
    (line, index) =>
      index >= startIndex && isClosingMarkdownFence(line, openingFence),
  );
}

function shouldParseHeaderInsideNonLatexFence(
  lines: readonly string[],
  headerIndex: number,
  openingFence: MarkdownFence,
  labelFiles: readonly string[],
): boolean {
  const closingIndex = findClosingFenceIndex(lines, headerIndex, openingFence);
  if (closingIndex === -1) return true;

  const bodyLines = lines.slice(headerIndex + 1, closingIndex);
  const linesAfterFence = lines.slice(closingIndex + 1);
  return (
    hasLikelyLatexContent(bodyLines) ||
    bodyLines.some((line) => matchHeaderName(line, labelFiles) !== null) ||
    !linesAfterFence.some((line) => matchHeaderName(line, labelFiles) !== null)
  );
}

/**
 * Recover named documents from filename headers in a raw response. Returns
 * the recovered documents in response order, or null when none were found.
 */
export function extractFilenameHeaderDocuments(
  outputContent: string,
  options: {
    thinkingTag: string;
    roundDir: string;
    /** Names a bare label may resolve to (declared outputs, else inputs). */
    labelFiles: readonly string[];
    /**
     * The name for a document synthesized from an unlabeled LaTeX prefix.
     * Null when the agent may write more than one file, which disables
     * prefix synthesis (there is no way to pick the right name).
     */
    synthesisName: string | null;
    /**
     * When an agent declares one generated output, models often repeat that
     * same output label for chunks of one artifact. Coalesce only that exact
     * target; multi-file and in-place edits still keep duplicate names unique.
     */
    coalesceRepeatedName?: string | null;
    wrapperTag: string;
  },
): Array<{ content: string; name: string }> | null {
  const {
    thinkingTag,
    roundDir,
    labelFiles,
    synthesisName,
    coalesceRepeatedName = null,
    wrapperTag,
  } = options;
  const documents: Array<{ content: string; name: string }> = [];
  const reservedFinalPaths = new Set<string>();
  let currentName: string | null = null;
  let currentLines: string[] = [];
  let preHeaderLines: string[] = [];
  let pendingPrefacedMarkdownFence: MarkdownFence | null = null;
  let currentMarkdownFence: MarkdownFence | null = null;
  let ignoreProseUntilNextHeader = false;
  let synthesizedSingleInputFromPrefix = false;
  let pendingSoleOutputChunk: { fence: MarkdownFence; lines: string[] } | null =
    null;
  let mayStartAdjacentSoleOutputChunk = false;
  let sawSoleOutputChunkLabel = false;

  const coalescedOutputName = coalesceRepeatedName
    ? safeDocumentName(coalesceRepeatedName)
    : null;
  const coalescedOutput = () =>
    coalescedOutputName
      ? documents.find((document) => document.name === coalescedOutputName)
      : undefined;

  const appendCoalescedContent = (source: string, content: string): void => {
    const name = safeDocumentName(source);
    const existing = documents.find((document) => document.name === name);
    if (existing) {
      existing.content = `${existing.content.trim()}\n\n${content}`;
    } else {
      reservedFinalPaths.add(
        getExtractedDocOutputFileName(name, roundDir).replaceAll('\\', '/'),
      );
      documents.push({ name, content });
    }
  };

  const flushCurrent = (): MarkdownFence | null => {
    if (!currentName) return null;
    const content = stripSurroundingMarkdownFence(currentLines)
      .join('\n')
      .trim();
    const carriedFence = currentMarkdownFence;
    if (content) {
      if (
        coalesceRepeatedName &&
        normalizeDocumentName(currentName) ===
          normalizeDocumentName(coalesceRepeatedName)
      ) {
        appendCoalescedContent(currentName, content);
        mayStartAdjacentSoleOutputChunk = true;
      } else {
        documents.push({
          name: makeUniquePercentHeaderName(
            currentName,
            reservedFinalPaths,
            roundDir,
          ),
          content,
        });
      }
    }
    currentLines = [];
    currentMarkdownFence = null;
    return carriedFence;
  };

  const lines = stripSurroundingMarkdownFence(
    stripDocumentsEnvelope(
      stripSurroundingMarkdownFence(
        stripDocumentsEnvelope(
          responseLines(outputContent, thinkingTag),
          wrapperTag,
        ),
      ),
      wrapperTag,
    ),
  );
  for (const [index, line] of lines.entries()) {
    const fence = parseMarkdownFenceDelimiter(line);
    const percentHeaderName =
      PERCENT_FILENAME_HEADER_REGEX.exec(line.trim())?.[1] ?? null;
    const headerName =
      percentHeaderName ?? matchKnownFileLabel(line, labelFiles);

    if (pendingSoleOutputChunk) {
      if (isClosingMarkdownFence(line, pendingSoleOutputChunk.fence)) {
        const content = pendingSoleOutputChunk.lines.join('\n').trim();
        if (content && coalesceRepeatedName) {
          appendCoalescedContent(coalesceRepeatedName, content);
          mayStartAdjacentSoleOutputChunk = true;
        }
        pendingSoleOutputChunk = null;
        ignoreProseUntilNextHeader = true;
        continue;
      }
      pendingSoleOutputChunk.lines.push(line);
      continue;
    }

    if (!currentName && fence) {
      if (
        coalesceRepeatedName &&
        coalescedOutput() &&
        isLatexMarkdownFence(fence) &&
        (mayStartAdjacentSoleOutputChunk || sawSoleOutputChunkLabel)
      ) {
        pendingSoleOutputChunk = { fence, lines: [] };
        sawSoleOutputChunkLabel = false;
        continue;
      }
      if (
        pendingPrefacedMarkdownFence &&
        isClosingMarkdownFence(line, pendingPrefacedMarkdownFence)
      ) {
        pendingPrefacedMarkdownFence = null;
      } else {
        pendingPrefacedMarkdownFence = fence;
      }
      ignoreProseUntilNextHeader = false;
      // This fence failed the sole-output-chunk gate above (whatever the
      // reason), so it is prose/example content, not a continuation of the
      // coalesced output — any pending "next chunk" label it followed no
      // longer applies to whatever comes after it.
      sawSoleOutputChunkLabel = false;
      continue;
    }

    if (
      !currentName &&
      pendingPrefacedMarkdownFence &&
      !isLatexMarkdownFence(pendingPrefacedMarkdownFence)
    ) {
      const openExampleFence = pendingPrefacedMarkdownFence;
      if (
        !headerName ||
        !shouldParseHeaderInsideNonLatexFence(
          lines,
          index,
          openExampleFence,
          labelFiles,
        )
      ) {
        continue;
      }
    }

    if (
      currentName &&
      currentMarkdownFence &&
      isClosingMarkdownFence(line, currentMarkdownFence) &&
      !getLatexDocumentContext(currentLines).insideDocumentBody &&
      !isInsideLiteralEnvironment(currentLines)
    ) {
      flushCurrent();
      currentName = null;
      preHeaderLines = [];
      pendingPrefacedMarkdownFence = null;
      ignoreProseUntilNextHeader = true;
      synthesizedSingleInputFromPrefix = false;
      sawSoleOutputChunkLabel = false;
      continue;
    }

    if (headerName && synthesizedSingleInputFromPrefix) {
      // A `%` header is a valid LaTeX comment and can stay in the
      // synthesized document's body, as can a filename-looking line inside
      // a verbatim-style environment; a bare label elsewhere is not LaTeX,
      // so drop it.
      if (percentHeaderName || isInsideLiteralEnvironment(currentLines)) {
        currentLines.push(line);
      }
      continue;
    }

    const linesBeforeHeader = currentName ? currentLines : preHeaderLines;
    // The keep-as-comment heuristic exists because a `%` header is
    // indistinguishable from a genuine LaTeX comment. A bare label is never
    // valid LaTeX, so for it only literal contexts apply — inside a
    // \begin{document} body or an unclosed verbatim-style environment, a
    // filename-looking line stays content. The preamble lookahead must not
    // swallow a label that separates a preamble-only file from the next
    // document.
    const keepHeaderAsContent = percentHeaderName
      ? shouldKeepPercentHeaderAsLatexComment(linesBeforeHeader, lines, index)
      : getLatexDocumentContext(linesBeforeHeader).insideDocumentBody ||
        isInsideLiteralEnvironment(linesBeforeHeader);
    if (headerName && !keepHeaderAsContent) {
      if (!currentName && hasLikelyLatexContent(preHeaderLines)) {
        if (synthesisName !== null) {
          currentName = synthesisName;
          // Keep the triggering `%` header as an in-document comment, but a
          // bare label is not LaTeX and must not enter the synthesized body.
          currentLines = percentHeaderName
            ? [...preHeaderLines, line]
            : [...preHeaderLines];
          currentMarkdownFence = pendingPrefacedMarkdownFence;
          pendingPrefacedMarkdownFence = null;
          preHeaderLines = [];
          ignoreProseUntilNextHeader = false;
          synthesizedSingleInputFromPrefix = true;
          sawSoleOutputChunkLabel = false;
          continue;
        }
        preHeaderLines = [];
      }
      const carriedFence = flushCurrent();
      currentName = headerName;
      currentMarkdownFence = pendingPrefacedMarkdownFence ?? carriedFence;
      pendingPrefacedMarkdownFence = null;
      preHeaderLines = [];
      ignoreProseUntilNextHeader = false;
      synthesizedSingleInputFromPrefix = false;
      mayStartAdjacentSoleOutputChunk = false;
      sawSoleOutputChunkLabel = false;
      continue;
    }

    if (currentName) {
      if (
        fence &&
        !currentMarkdownFence &&
        !currentLines.some((currentLine) => currentLine.trim() !== '')
      ) {
        currentMarkdownFence = fence;
        continue;
      }
      currentLines.push(line);
    } else if (!ignoreProseUntilNextHeader) {
      preHeaderLines.push(line);
      mayStartAdjacentSoleOutputChunk = line.trim() === '';
      sawSoleOutputChunkLabel = false;
    } else if (line.trim() === '') {
      // Keep mayStartAdjacentSoleOutputChunk as-is: a chunk may follow the
      // previous one after blank separation.
    } else if (
      coalesceRepeatedName &&
      coalescedOutput() &&
      FILE_LIKE_LABEL_REGEX.test(line)
    ) {
      sawSoleOutputChunkLabel = true;
    } else {
      mayStartAdjacentSoleOutputChunk = false;
      sawSoleOutputChunkLabel = false;
    }
  }
  flushCurrent();

  return documents.length === 0 ? null : documents;
}
