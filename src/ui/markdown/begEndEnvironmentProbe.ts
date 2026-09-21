// The `beg_end` environment probe: a tiny markdown-it block probe that records
// exactly where texmath's `beg_end` rule would open an environment, plus the
// shielding pass that swaps each recorded environment for placeholders.

import MarkdownIt, { type StateBlock } from 'markdown-it';

import {
  MARKDOWN_PARSER_OPTIONS,
  type MarkdownItInstance,
} from './createMarkdownRenderer';
import { DISPLAY_MATH_SPAN_PATTERNS } from './latexPlaceholders';

interface BegEndEnvironmentMatch {
  readonly start: number;
  readonly end: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly lineContentStarts: readonly number[];
}

interface SourceRange {
  readonly start: number;
  readonly end: number;
}

export interface BegEndEnvironmentProbe {
  collect(
    content: string,
    excludedRanges: readonly SourceRange[],
  ): readonly BegEndEnvironmentMatch[];
}

// A tiny markdown-it block probe that records exactly where texmath's
// `beg_end` rule would open an environment. It is a faithful container/fence-
// aware replacement for the source-level regex: it runs inside markdown-it's
// block parser, so it inherits bMarks/tShift, container prefix stripping, lazy
// list continuations, and fence consumption for free. It also installs the
// same paragraph-interruption rule the webview's texmath plugin uses, which is
// what lets `10. Formula:\n    \begin{align}` open an environment on the
// indented continuation line. The probe returns true to consume a match (but
// pushes no token), so the recorded match set follows texmath's parse exactly.
export function createProbeMarkdownIt(): MarkdownItInstance {
  const probe = new MarkdownIt({ ...MARKDOWN_PARSER_OPTIONS });
  probe.linkify.set({ fuzzyLink: true, urlAuth: true });
  return probe;
}

// Binary search over a non-decreasing `valueAt(index)`: the first index whose
// value is strictly greater than `target` (== the count of entries <= target).
function upperBoundIndex(
  length: number,
  target: number,
  valueAt: (index: number) => number,
): number {
  let low = 0;
  let high = length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (valueAt(mid) <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function createBegEndEnvironmentProbe(
  probe: MarkdownItInstance,
): BegEndEnvironmentProbe {
  let active = false;
  let matches: BegEndEnvironmentMatch[] = [];
  let closersByEnv = new Map<string, number[]>();
  let excludedRanges: readonly SourceRange[] = [];
  const beginEnvPattern = /\\begin\{([a-z]+)\}/y;

  const isInsideExcludedRange = (position: number): boolean => {
    const after = upperBoundIndex(
      excludedRanges.length,
      position,
      (index) => excludedRanges[index]!.start,
    );
    const range = excludedRanges[after - 1];
    return range !== undefined && position < range.end;
  };

  const firstCloserAfter = (closers: readonly number[], openEnd: number) => {
    const after = upperBoundIndex(
      closers.length,
      openEnd,
      (index) => closers[index]!,
    );
    return after < closers.length ? closers[after]! : undefined;
  };

  const rule = (
    state: StateBlock,
    startLine: number,
    _endLine: number,
    silent: boolean,
  ): boolean => {
    if (!active) return false;
    const pos = state.bMarks[startLine]! + state.tShift[startLine]!;
    if (isInsideExcludedRange(pos)) return false;
    const source = state.src;
    if (source.charCodeAt(pos) !== 0x5c) return false;
    beginEnvPattern.lastIndex = pos;
    const opener = beginEnvPattern.exec(source);
    if (opener === null) return false;
    const name = opener[1]!;
    const openEnd = beginEnvPattern.lastIndex;
    const closers = closersByEnv.get(name);
    if (closers === undefined) return false;
    const closeStart = firstCloserAfter(closers, openEnd);
    if (closeStart === undefined) return false;
    const closeEnd = closeStart + 4 + name.length + 2; // \end{name}
    // Last line whose block starts at or before the closer (bMarks[0] is 0).
    const closerLine =
      upperBoundIndex(
        state.bMarks.length,
        closeStart,
        (index) => state.bMarks[index]!,
      ) - 1;
    if (silent) return true;

    const lineContentStarts: number[] = [];
    for (let line = startLine; line <= closerLine; line++) {
      lineContentStarts.push(state.bMarks[line]! + state.tShift[line]!);
    }
    matches.push({
      start: pos,
      end: closeEnd,
      startLine,
      endLine: closerLine,
      lineContentStarts,
    });
    state.line = closerLine + 1;
    return true;
  };

  probe.block.ruler.before('fence', 'texra_beg_end_probe', rule, {});
  probe.block.ruler.before('paragraph', 'texra_beg_end_probe_interrupt', rule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });

  return {
    collect(
      content: string,
      ranges: readonly SourceRange[],
    ): readonly BegEndEnvironmentMatch[] {
      matches = [];
      excludedRanges = ranges;
      // Most messages have no environment delimiters; skip both markdown
      // parses entirely in that case.
      if (!content.includes('\\begin{') || !content.includes('\\end{')) {
        return matches;
      }

      // Cheap compatibility precheck: only pay for a markdown parse when at
      // least one lowercase opener name also has a lowercase closer.
      const openerNames = new Set<string>();
      for (const opener of content.matchAll(/\\begin\{([a-z]+)\}/g)) {
        openerNames.add(opener[1]!);
      }
      if (openerNames.size === 0) return matches;

      closersByEnv = new Map();
      for (const closer of content.matchAll(/\\end\{([a-z]+)\}/g)) {
        const name = closer[1]!;
        const positions = closersByEnv.get(name) ?? [];
        positions.push(closer.index);
        closersByEnv.set(name, positions);
      }
      if (![...openerNames].some((name) => closersByEnv.has(name))) {
        return matches;
      }

      active = true;
      try {
        probe.parse(content, {});
      } finally {
        active = false;
      }
      if (matches.length === 0) return matches;

      // Only pay for a second (plain) parse when a candidate match could cross
      // a fence; the probe parse consumed math blocks, so it cannot enumerate
      // fences for the decline check. (The finally block above already
      // deactivated the probe rule.)
      const fenceTokens = probe.parse(content, {});
      const fenceRanges: Array<readonly [number, number]> = [];
      for (const token of fenceTokens) {
        if (token.type === 'fence' && token.map !== null) {
          fenceRanges.push([token.map[0], token.map[1]]);
        }
      }

      // Keep the earlier deliberate fence-decline: texmath would match across
      // a fenced-code boundary, but shielding that would swallow the fence and
      // its prose into a math placeholder. Under-shield instead. This is the
      // one documented divergence from the webview's beg_end parse.
      return matches.filter(
        (match) =>
          !fenceRanges.some(
            ([start, end]) => match.startLine < end && match.endLine >= start,
          ),
      );
    },
  };
}

// Blockquote markers markdown-it will still need to see after an environment
// is shielded. The leading indentation before each `>` and the marker itself
// stay visible; any extra whitespace after the marker is list/continuation
// indent and is restored from the placeholder instead, matching the existing
// `\[…\]` blockquote-prefix behaviour.
function retainedBlockquotePrefix(prefix: string): string {
  return /^(?:(?:[ \t]*>[ \t]?))+/u.exec(prefix)?.[0] ?? '';
}

const LIST_MARKER_PREFIX_RE = /^(?:[ \t]*(?:[-+*]|\d+[.)])[ \t]+)/u;

function lineBoundaries(content: string): {
  readonly lineStarts: number[];
  readonly lineEnds: number[];
} {
  const lineStarts = [0];
  const lineEnds: number[] = [];
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) {
      lineEnds.push(index);
      lineStarts.push(index + 1);
    }
  }
  lineEnds.push(content.length);
  return { lineStarts, lineEnds };
}

export function applyEnvironmentShields(
  content: string,
  matches: readonly BegEndEnvironmentMatch[],
  tag: string,
  items: string[],
): string {
  if (matches.length === 0) return content;
  const { lineStarts, lineEnds } = lineBoundaries(content);
  const sorted = matches.toSorted((a, b) => a.start - b.start);
  const pieces: string[] = [];
  let copiedUntil = 0;
  for (const match of sorted) {
    if (match.start < copiedUntil) continue;
    pieces.push(content.slice(copiedUntil, lineStarts[match.startLine]!));
    for (let line = match.startLine; line <= match.endLine; line++) {
      const contentStart = match.lineContentStarts[line - match.startLine]!;
      const lineStart = lineStarts[line]!;
      const lineEnd = lineEnds[line]!;
      const fullPrefix = content.slice(lineStart, contentStart);
      const retained = retainedBlockquotePrefix(fullPrefix);
      const remainder = fullPrefix.slice(retained.length);
      const hasListMarker = LIST_MARKER_PREFIX_RE.test(remainder);
      // Keep list markers visible on the line; move extra blockquote-
      // continuation indent into the item so markdown-it does not strip it
      // when it builds the list-item paragraph content.
      const moveIndentIntoItem = retained.length > 0 && !hasListMarker;
      pieces.push(moveIndentIntoItem ? retained : fullPrefix);
      const isLast = line === match.endLine;
      const contentEnd = isLast ? match.end : lineEnd;
      const item =
        (moveIndentIntoItem ? remainder : '') +
        content.slice(contentStart, contentEnd);
      if (item.length > 0) {
        const index = items.push(item) - 1;
        pieces.push(`@@${tag}-${index}@@`);
      }
      if (!isLast) pieces.push(content.slice(lineEnd, lineStarts[line + 1]!));
    }
    copiedUntil = match.end;
  }
  pieces.push(content.slice(copiedUntil));
  return pieces.join('');
}

// Display-math ranges texmath would consume before its `beg_end` block rule
// runs. The render/normalize shields apply these same display patterns after
// environment shielding, so an environment opener inside one of these ranges
// must not be shielded first.
export function findDisplayMathRanges(content: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  for (const pattern of DISPLAY_MATH_SPAN_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const start = match.index ?? 0;
      ranges.push({ start, end: start + match[0].length });
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}
