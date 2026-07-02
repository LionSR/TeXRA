/**
 * Filename-header document recovery for fallback output extraction.
 *
 * Splits a raw model response into named documents by recognizing
 * `% path/file.ext` comment headers and bare known-file labels, handling
 * markdown fences around each document and the ambiguity of `%` headers
 * that are really LaTeX comments.
 */

import * as path from 'node:path';

import {
  getExtractedDocOutputFileName,
  getSafeDocumentRelativePath,
} from '@agent/utils/outputFileUtils';
import { getBasename, normalizeFilePath } from '@shared/utils/path';

import {
  getLatexDocumentContext,
  hasLikelyLatexContent,
  shouldKeepPercentHeaderAsLatexComment,
} from './latexHeuristics';
import {
  isClosingMarkdownFence,
  type MarkdownFence,
  parseMarkdownFenceDelimiter,
  stripSurroundingMarkdownFence,
} from './markdownFences';
import { responseLines } from './responseText';

const PERCENT_FILENAME_HEADER_REGEX =
  /^%\s+((?:\.[/\\])*[A-Za-z0-9_][A-Za-z0-9._/\\-]*\.[A-Za-z0-9]+)\s*$/;
/** Strip markdown emphasis/label punctuation a model might wrap a bare filename in. */
const BARE_LABEL_DECORATION_REGEX = /^[*_`]+|[*_`:]+$/g;

/**
 * Recognize a header line that names one of the agent's known files directly,
 * without the `%` comment prefix (e.g. `Draft/Draft3.tex:` or
 * `**Draft3.tex**`). Unlike the percent-header form, a bare line like this is
 * never valid LaTeX on its own, so the only ambiguity risk is a coincidental
 * match — guarded against by only ever matching against the agent's own
 * known files rather than any path-shaped string.
 */
function matchKnownFileLabel(
  line: string,
  knownFiles: readonly string[],
): string | null {
  const stripped = line.trim().replaceAll(BARE_LABEL_DECORATION_REGEX, '');
  if (!stripped) return null;
  const candidate = normalizeFilePath(stripped).replace(/^(?:\.\/)+/, '');
  const exact = knownFiles.find((f) => normalizeFilePath(f) === candidate);
  if (exact) return exact;

  // Fall back to a basename match when the model dropped the leading
  // directories, but only when it resolves unambiguously.
  const basenameMatches = knownFiles.filter(
    (f) => getBasename(f) === candidate,
  );
  return basenameMatches.length === 1 ? basenameMatches[0] : null;
}

function makeUniquePercentHeaderName(
  source: string,
  reservedFinalPaths: Set<string>,
  roundDir: string,
): string {
  const normalized = source.replaceAll('\\', '/');
  const safeName = getSafeDocumentRelativePath(normalized).replaceAll(
    '\\',
    '/',
  );
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
  },
): Array<{ content: string; name: string }> | null {
  const { thinkingTag, roundDir, labelFiles, synthesisName } = options;
  const documents: Array<{ content: string; name: string }> = [];
  const reservedFinalPaths = new Set<string>();
  let currentName: string | null = null;
  let currentLines: string[] = [];
  let preHeaderLines: string[] = [];
  let pendingPrefacedMarkdownFence: MarkdownFence | null = null;
  let currentMarkdownFence: MarkdownFence | null = null;
  let ignoreProseUntilNextHeader = false;
  let synthesizedSingleInputFromPrefix = false;

  const flushCurrent = (): MarkdownFence | null => {
    if (!currentName) return null;
    const content = stripSurroundingMarkdownFence(currentLines)
      .join('\n')
      .trim();
    const carriedFence = content ? null : currentMarkdownFence;
    if (content) {
      documents.push({
        name: makeUniquePercentHeaderName(
          currentName,
          reservedFinalPaths,
          roundDir,
        ),
        content,
      });
    }
    currentLines = [];
    currentMarkdownFence = null;
    return carriedFence;
  };

  const lines = stripSurroundingMarkdownFence(
    responseLines(outputContent, thinkingTag),
  );
  for (const [index, line] of lines.entries()) {
    const fence = parseMarkdownFenceDelimiter(line);

    if (!currentName && fence) {
      if (
        pendingPrefacedMarkdownFence &&
        isClosingMarkdownFence(line, pendingPrefacedMarkdownFence)
      ) {
        pendingPrefacedMarkdownFence = null;
      } else {
        pendingPrefacedMarkdownFence = fence;
      }
      ignoreProseUntilNextHeader = false;
      continue;
    }

    if (
      currentName &&
      currentMarkdownFence &&
      isClosingMarkdownFence(line, currentMarkdownFence) &&
      !getLatexDocumentContext(currentLines).insideDocumentBody
    ) {
      flushCurrent();
      currentName = null;
      preHeaderLines = [];
      pendingPrefacedMarkdownFence = null;
      ignoreProseUntilNextHeader = true;
      synthesizedSingleInputFromPrefix = false;
      continue;
    }

    const percentHeaderName =
      PERCENT_FILENAME_HEADER_REGEX.exec(line.trim())?.[1] ?? null;
    const headerName =
      percentHeaderName ?? matchKnownFileLabel(line, labelFiles);
    if (headerName && synthesizedSingleInputFromPrefix) {
      // A `%` header is a valid LaTeX comment and can stay in the
      // synthesized document's body; a bare label is not LaTeX, so drop it.
      if (percentHeaderName) {
        currentLines.push(line);
      }
      continue;
    }

    const linesBeforeHeader = currentName ? currentLines : preHeaderLines;
    // The keep-as-comment heuristic exists because a `%` header is
    // indistinguishable from a genuine LaTeX comment. A bare label is never
    // valid LaTeX, so for it only the inside-document-body check applies
    // (a filename-looking line in a verbatim example stays content); the
    // preamble lookahead must not swallow a label that separates a
    // preamble-only file from the next document.
    const keepHeaderAsContent = percentHeaderName
      ? shouldKeepPercentHeaderAsLatexComment(linesBeforeHeader, lines, index)
      : getLatexDocumentContext(linesBeforeHeader).insideDocumentBody;
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
    }
  }
  flushCurrent();

  return documents.length === 0 ? null : documents;
}
