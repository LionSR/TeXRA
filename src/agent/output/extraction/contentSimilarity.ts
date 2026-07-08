/**
 * Content-similarity document recovery for fallback output extraction.
 *
 * Collects unlabeled ```latex/```tex fenced blocks from a response and pairs
 * each with the base file it most closely resembles via a diff-match-patch
 * diff, so blocks can be routed to filenames without trusting response order.
 */

import escapeRegExp from 'escape-string-regexp';

import { diffTextLevenshtein } from '@utils/text/diff';

// ---------------------------------------------------------------------------
// responseText
// ---------------------------------------------------------------------------

/**
 * Response-text preprocessing for fallback output extraction.
 *
 * Strips the model's thinking-tag XML blocks from a raw response and
 * normalizes the remainder into lines, so the header/fence recovery
 * heuristics only ever see candidate document text.
 */

function stripXmlTagBlocks(content: string, tagName: string): string {
  const trimmedTag = tagName.trim();
  if (!trimmedTag) {
    return content;
  }
  return content.replaceAll(
    new RegExp(
      `<${escapeRegExp(trimmedTag)}\\b[^>]*>[\\s\\S]*?<\\/${escapeRegExp(trimmedTag)}>`,
      'gi',
    ),
    '',
  );
}

/** Strip `thinkingTag` blocks, normalize CRLF/CR to LF, and split into lines. */
export function responseLines(content: string, thinkingTag: string): string[] {
  return stripXmlTagBlocks(content, thinkingTag)
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n');
}

// ---------------------------------------------------------------------------
// markdownFences
// ---------------------------------------------------------------------------

/**
 * Markdown code-fence recognition for fallback output extraction.
 *
 * Parses backtick/tilde fence delimiter lines and strips a fence that wraps
 * an entire block of lines, following CommonMark's closing-fence rule (same
 * marker, at least the opening delimiter's length).
 */

export type MarkdownFence = {
  marker: '`' | '~';
  length: number;
  info: string;
};

export function parseMarkdownFenceDelimiter(
  line: string,
): MarkdownFence | null {
  const match = /^(`{3,}|~{3,})(?:\s*(.*?))?\s*$/.exec(line.trim());
  if (!match) {
    return null;
  }
  const delimiter = match[1];
  return {
    marker: delimiter[0] as '`' | '~',
    length: delimiter.length,
    info: (match[2] ?? '').trim(),
  };
}

export function isLatexMarkdownFence(fence: MarkdownFence): boolean {
  return fence.info === '' || /^(?:latex|tex)$/i.test(fence.info);
}

export function isClosingMarkdownFence(
  line: string,
  openingFence: MarkdownFence,
): boolean {
  const closingFence = parseMarkdownFenceDelimiter(line);
  return (
    closingFence !== null &&
    closingFence.marker === openingFence.marker &&
    closingFence.length >= openingFence.length
  );
}

/**
 * Strip a first/last wrapper line off `lines` when the first non-blank line
 * opens a wrapper (per `isOpen`) and the last non-blank line closes it (per
 * `isClose`, given the matched open line). Shared by
 * {@link stripSurroundingMarkdownFence} (fence markers) and
 * `stripDocumentsEnvelope` (XML-style tag wrapper) in `filenameHeaders.ts`.
 *
 * `options.emptyOnNoContent` controls the result when `lines` is entirely
 * blank (fence stripping collapses to `[]`; the tag-envelope stripper leaves
 * blank input untouched). `options.rejectInnerClose` additionally refuses to
 * strip when some line strictly between the first and last also closes the
 * wrapper (fence stripping must not treat a nested same-marker fence's close
 * as the outer one; the tag envelope has no such nesting concern).
 */
export function stripFirstLastLineIfWrapped(
  lines: readonly string[],
  isOpen: (line: string) => boolean,
  isClose: (openLine: string, line: string) => boolean,
  options: { emptyOnNoContent?: boolean; rejectInnerClose?: boolean } = {},
): string[] {
  const firstContentIndex = lines.findIndex((line) => line.trim() !== '');
  if (firstContentIndex === -1) {
    return options.emptyOnNoContent ? [] : [...lines];
  }

  const lastContentIndex = lines.findLastIndex((line) => line.trim() !== '');
  const firstLine = lines[firstContentIndex];
  const wrapped =
    firstContentIndex < lastContentIndex &&
    isOpen(firstLine) &&
    isClose(firstLine, lines[lastContentIndex]) &&
    (!options.rejectInnerClose ||
      !lines
        .slice(firstContentIndex + 1, lastContentIndex)
        .some((line) => isClose(firstLine, line)));

  if (!wrapped) {
    return [...lines];
  }
  return [
    ...lines.slice(0, firstContentIndex),
    ...lines.slice(firstContentIndex + 1, lastContentIndex),
    ...lines.slice(lastContentIndex + 1),
  ];
}

export function stripSurroundingMarkdownFence(
  lines: readonly string[],
): string[] {
  // `isClose` is always invoked with the same `openLine` (the wrapper's first
  // content line) across a single stripFirstLastLineIfWrapped call, including
  // once per line during the rejectInnerClose scan — parse it once and reuse.
  let cachedOpeningFence: MarkdownFence | null | undefined;
  return stripFirstLastLineIfWrapped(
    lines,
    (line) => parseMarkdownFenceDelimiter(line) !== null,
    (openLine, line) => {
      cachedOpeningFence ??= parseMarkdownFenceDelimiter(openLine);
      return (
        cachedOpeningFence !== null &&
        isClosingMarkdownFence(line, cachedOpeningFence)
      );
    },
    { emptyOnNoContent: true, rejectInnerClose: true },
  );
}

// ---------------------------------------------------------------------------
// contentSimilarity
// ---------------------------------------------------------------------------

/** Opening delimiter for a fenced block explicitly tagged as latex/tex. */
const LATEX_FENCE_OPEN_REGEX = /^(`{3,}|~{3,})\s*(?:latex|tex)\s*$/i;

/** Collect the content of every ```latex/```tex fenced block, in document order. */
export function collectLatexFencedBlocks(
  content: string,
  thinkingTag: string,
  options: {
    onUnclosedFence?: (lineCount: number) => void;
  } = {},
): string[] {
  const lines = responseLines(content, thinkingTag);

  const blocks: string[] = [];
  let openFence: MarkdownFence | null = null;
  let current: string[] = [];

  for (const line of lines) {
    if (!openFence) {
      if (LATEX_FENCE_OPEN_REGEX.test(line.trim())) {
        openFence = parseMarkdownFenceDelimiter(line);
        current = [];
      }
      continue;
    }
    if (isClosingMarkdownFence(line, openFence)) {
      const block = current.join('\n').trim();
      if (block) blocks.push(block);
      openFence = null;
      current = [];
      continue;
    }
    current.push(line);
  }
  if (openFence && current.some((line) => line.trim() !== '')) {
    options.onUnclosedFence?.(current.length);
  }
  return blocks;
}

/**
 * Similarity in [0, 1] between two documents via a `diff-match-patch` Myers
 * diff (with the line-mode speedup enabled, which keeps this cheap for
 * large, mostly-unchanged documents): 1 minus the diff's edit distance,
 * normalized by the longer document's length. Clamped at 0 because
 * `diff_levenshtein` counts a substitution as delete-plus-insert, which can
 * exceed the longer length for very different documents.
 */
function documentSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLength = Math.max(a.length, b.length, 1);
  const distance = diffTextLevenshtein(a, b, { checkLines: true });
  return Math.max(0, 1 - distance / maxLength);
}

/**
 * Greedily pair each candidate document with the base file it most closely
 * resembles, highest-confidence pairs first, so an unambiguous match never
 * gets displaced by a later tie. Never guesses: candidates below
 * `minSimilarity`, candidates whose best remaining files tie exactly (e.g.
 * identical template stubs), and leftovers once the other side is exhausted
 * all come back unmatched.
 */
export function assignByContentSimilarity(
  candidates: readonly string[],
  files: ReadonlyArray<{ name: string; content: string }>,
  minSimilarity = 0.15,
): Array<{ content: string; name: string } | null> {
  const scores = candidates.map((candidate) =>
    files.map((file) => documentSimilarity(candidate, file.content)),
  );
  const bestScoreOf = scores.map((row) => Math.max(...row));

  // A block that echoes a base file verbatim (modulo surrounding whitespace —
  // fenced blocks arrive trimmed) while some other block's best match is that
  // same file is a quote of the original, not a revision (the model quoted
  // the original before its revision). Such a block is excluded from
  // assignment entirely: letting it fall back to a different, merely-similar
  // file would write one file's stale content over another.
  //
  // The competing block must clear a higher bar than the routing threshold:
  // a genuine rewrite stays broadly similar to the file it revises, and
  // dropping an exact copy (a legitimately unchanged output) for a weak
  // stray snippet would lose real content.
  const ECHO_DISPLACEMENT_MIN_SIMILARITY = 0.5;
  const trimmedFileContents = files.map((file) => file.content.trim());
  const isDisplacedEcho = (c: number, f: number): boolean =>
    candidates[c].trim() === trimmedFileContents[f] &&
    candidates.some(
      (_, other) =>
        other !== c &&
        candidates[other].trim() !== trimmedFileContents[f] &&
        // Best-match check by score, not argmax index, so a revision tied
        // across several files displaces the echo of each of them.
        scores[other][f] === bestScoreOf[other] &&
        scores[other][f] >= ECHO_DISPLACEMENT_MIN_SIMILARITY,
    );
  const quotedOriginals = new Set(
    [...candidates.keys()].filter((c) =>
      [...files.keys()].some((f) => isDisplacedEcho(c, f)),
    ),
  );

  const scored: Array<{ c: number; f: number; score: number }> = [];
  for (const c of candidates.keys()) {
    if (quotedOriginals.has(c)) continue;
    for (const f of files.keys()) {
      scored.push({ c, f, score: scores[c][f] });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  const takenCandidates = new Set<number>();
  const takenFiles = new Set<number>();
  const nameByCandidate = new Map<number, string>();
  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    for (const { c, f, score } of scored) {
      if (score < minSimilarity) break;
      if (score < bestScoreOf[c]) continue;
      if (takenCandidates.has(c) || takenFiles.has(f)) continue;
      // An exact score tie against another still-free file means there is no
      // evidence which file this block belongs to yet. Leave it for a later
      // pass: another candidate may claim one of the tied files, making this
      // candidate's remaining match unambiguous.
      const ambiguous = scored.some(
        (other) =>
          other.c === c &&
          other.f !== f &&
          !takenFiles.has(other.f) &&
          other.score === score,
      );
      if (ambiguous) continue;
      takenCandidates.add(c);
      takenFiles.add(f);
      nameByCandidate.set(c, files[f].name);
      madeProgress = true;
    }
  }

  return candidates.map((content, idx) => {
    const name = nameByCandidate.get(idx);
    return name ? { content, name } : null;
  });
}
