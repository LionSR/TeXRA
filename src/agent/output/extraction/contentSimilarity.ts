/**
 * Content-similarity document recovery for fallback output extraction.
 *
 * Collects unlabeled ```latex/```tex fenced blocks from a response and pairs
 * each with the base file it most closely resembles via a diff-match-patch
 * diff, so blocks can be routed to filenames without trusting response order.
 */

import { diff_match_patch } from 'diff-match-patch';

import {
  isClosingMarkdownFence,
  type MarkdownFence,
  parseMarkdownFenceDelimiter,
} from './markdownFences';
import { responseLines } from './responseText';

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
function documentSimilarity(
  dmp: InstanceType<typeof diff_match_patch>,
  a: string,
  b: string,
): number {
  if (a === b) return 1;
  const maxLength = Math.max(a.length, b.length, 1);
  const diffs = dmp.diff_main(a, b, true);
  return Math.max(0, 1 - dmp.diff_levenshtein(diffs) / maxLength);
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
  const dmp = new diff_match_patch();
  const scores = candidates.map((candidate) =>
    files.map((file) => documentSimilarity(dmp, candidate, file.content)),
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
