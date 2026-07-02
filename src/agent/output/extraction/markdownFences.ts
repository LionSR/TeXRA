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
};

export function parseMarkdownFenceDelimiter(
  line: string,
): MarkdownFence | null {
  const match = /^(`{3,}|~{3,})(?:\s*\S.*)?\s*$/.exec(line.trim());
  if (!match) {
    return null;
  }
  const delimiter = match[1];
  return {
    marker: delimiter[0] as '`' | '~',
    length: delimiter.length,
  };
}

function isMarkdownFenceDelimiter(line: string): boolean {
  return parseMarkdownFenceDelimiter(line) !== null;
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

export function stripSurroundingMarkdownFence(
  lines: readonly string[],
): string[] {
  const firstContentIndex = lines.findIndex((line) => line.trim() !== '');
  if (firstContentIndex === -1) {
    return [];
  }

  const lastContentIndex = lines.findLastIndex((line) => line.trim() !== '');
  if (
    firstContentIndex < lastContentIndex &&
    isMarkdownFenceDelimiter(lines[firstContentIndex]) &&
    isMarkdownFenceDelimiter(lines[lastContentIndex])
  ) {
    return [
      ...lines.slice(0, firstContentIndex),
      ...lines.slice(firstContentIndex + 1, lastContentIndex),
      ...lines.slice(lastContentIndex + 1),
    ];
  }

  return [...lines];
}
