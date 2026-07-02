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

export function getLatexDocumentContext(lines: readonly string[]): {
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

export function shouldKeepPercentHeaderAsLatexComment(
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

export function hasLikelyLatexContent(lines: readonly string[]): boolean {
  return lines.some((line) => LIKELY_LATEX_CONTENT_REGEX.test(line.trim()));
}

const LITERAL_ENV_BOUNDARY_REGEX =
  /\\(begin|end)\s*\{\s*(?:verbatim\*?|lstlisting|minted|Verbatim)\s*\}/g;

/**
 * Whether the last of these lines sits inside an unclosed verbatim-style
 * environment, whose content is literal text — a filename-looking line
 * there is part of the listing, not a document header.
 */
export function isInsideLiteralEnvironment(lines: readonly string[]): boolean {
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
