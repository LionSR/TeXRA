// Placeholder protect/restore machinery shared by the markdown shields:
// regexes for the LaTeX math spans and stray macros, the collision-free
// `@@<tag>-N@@` placeholder tag selection, and the fixpoint restore pass.

// Inline `$…$` requires both delimiters to be unescaped (`\$` is a literal
// dollar in LaTeX, not a delimiter) and on the same line, which keeps stray
// currency `$` from being captured and avoids cascading mis-splits. One or
// more adjacent spans chain so `$a$$b$` shields as a single unit.
const INLINE_MATH_SPAN_PATTERN =
  /(?<!\\)\$(?!\$)[^\n$]+?(?<![\\$])\$(?:\$(?!\$)[^\n$]+?(?<![\\$])\$)*/g;

// Display and inline delimiter regexes used by the render shield before the
// bounded inline-dollar scanner runs, and by the lax HTML-normalize shield.
export const DISPLAY_MATH_SPAN_PATTERNS: readonly RegExp[] = [
  /\$\$[\s\S]+?\$\$/g, // $$ … $$  (display, may span lines)
  /(?<!\\)\\\[[\s\S]+?(?<!\\)\\\]/g, // \[ … \]  (display)
  /(?<!\\)\\\([\s\S]+?(?<!\\)\\\)/g, // \( … \)  (inline)
];

// Lax HTML-normalize math pattern set: display fences first so `$…$` never
// splits a `$$…$$`, then the intentionally lax inline `$…$` regex.
export const MATH_SPAN_PATTERNS: readonly RegExp[] = [
  ...DISPLAY_MATH_SPAN_PATTERNS,
  INLINE_MATH_SPAN_PATTERN,
];

// LaTeX backslash-macros whose trailing character is CommonMark-escapable
// punctuation, so markdown-it's parser strips the backslash (`\;`→`;`,
// `\(`→`(`, …). These are the math spacing macros (`\,` `\;` `\:` `\!`), the
// inline/display math delimiters (`\(` `\)` `\[` `\]`) and literal braces
// (`\{` `\}`) — all meaningful LaTeX and effectively never an intentional
// markdown escape in math output. We deliberately exclude `\$` `\#` `\&` `\%`
// `\_` `\*` etc., which carry real markdown-escape semantics.
export const LATEX_MACRO = /\\([,;:!(){}[\]])/g;

export function selectPlaceholderTag(
  content: string,
  requestedTag: string,
): string {
  let tag = requestedTag;
  while (content.includes(`@@${tag}-`)) tag += '@';
  return tag;
}

export function restorePlaceholders(
  content: string,
  placeholder: RegExp,
  items: string[],
): string {
  // An item can itself carry a placeholder when spans nest across patterns
  // (a `\begin{…}…\end{…}` placeholder inside a later `$$…$$` / `\[…\]`
  // fence), so run to a fixpoint instead of a single pass. Nesting is acyclic
  // — a pattern's matches can capture earlier patterns' placeholders but never
  // their own — and selectPlaceholderTag keeps placeholder-shaped user text
  // out of the items, so the loop terminates.
  let restored = content;
  for (;;) {
    const next = restored.replaceAll(placeholder, (match, rawIndex) => {
      const item = items[Number(rawIndex)];
      return item ?? match;
    });
    if (next === restored) return restored;
    restored = next;
  }
}

// Replace every match of `patterns` with an indexed `@@<tag>-N@@` placeholder,
// appending the captured matches to `items` so later shields share one restore
// pass. `tag` must already be collision-free (see selectPlaceholderTag).
export function protectPatternsInto(
  content: string,
  patterns: readonly RegExp[],
  tag: string,
  items: string[],
  preserveBlockquotePrefixes: boolean,
): string {
  let out = content;
  for (const pattern of patterns) {
    out = out.replaceAll(pattern, (match, ...args: unknown[]) => {
      if (preserveBlockquotePrefixes && match.includes('\n')) {
        // Keep Markdown blockquote prefixes visible to the parser instead of
        // collapsing an entire quoted display span into one placeholder line.
        const offset = args.at(-2) as number;
        const source = args.at(-1) as string;
        const firstLineStart = source.lastIndexOf('\n', offset - 1) + 1;
        const firstLinePrefix = source.slice(firstLineStart, offset);
        const firstContainerPrefix =
          /^(?:(?:[ \t]*>[ \t]?)|(?:[ \t]*(?:[-+*]|\d+[.)])[ \t]+))+/u.exec(
            firstLinePrefix,
          )?.[0] ?? '';
        const quoteDepth = [...firstContainerPrefix].filter(
          (char) => char === '>',
        ).length;
        const requiredPrefix = new RegExp(
          `^(?:[ \\t]*>[ \\t]?){${quoteDepth}}`,
          'u',
        );
        const lines = match.split('\n');
        const remainingLines = lines.slice(1);
        const remainingPrefixes = remainingLines.map(
          (line) => requiredPrefix.exec(line)?.[0],
        );
        const availablePrefix = new RegExp(
          `^(?:[ \\t]*>[ \\t]?){1,${Math.max(quoteDepth, 1)}}`,
          'u',
        );
        const availablePrefixes = remainingLines.map(
          (line) => availablePrefix.exec(line)?.[0],
        );
        const isQuotedSpan =
          quoteDepth > 0 &&
          remainingPrefixes.at(-1) !== undefined &&
          remainingPrefixes.every(
            (prefix, index) =>
              prefix !== undefined ||
              (remainingLines[index]?.trim().length ?? 0) > 0,
          );
        if (isQuotedSpan) {
          return lines
            .map((line, lineIndex) => {
              const retainedPrefix =
                lineIndex === 0 ? '' : (remainingPrefixes[lineIndex - 1] ?? '');
              const contentPrefix =
                lineIndex === 0 ? '' : (availablePrefixes[lineIndex - 1] ?? '');
              const index = items.push(line.slice(contentPrefix.length)) - 1;
              return `${retainedPrefix}@@${tag}-${index}@@`;
            })
            .join('\n');
        }
        // An unquoted span falls through to the whole-match placeholder below.
      }
      const index = items.push(match) - 1;
      return `@@${tag}-${index}@@`;
    });
  }
  return out;
}

export function protectByPatterns(
  content: string,
  patterns: readonly RegExp[],
  tag: string,
  preserveBlockquotePrefixes = false,
): { content: string; restore: (value: string) => string } {
  const items: string[] = [];
  const selectedTag = selectPlaceholderTag(content, tag);
  const protectedContent = protectPatternsInto(
    content,
    patterns,
    selectedTag,
    items,
    preserveBlockquotePrefixes,
  );
  const placeholder = new RegExp(`@@${selectedTag}-(\\d+)@@`, 'g');
  return {
    content: protectedContent,
    restore: (value) => restorePlaceholders(value, placeholder, items),
  };
}
