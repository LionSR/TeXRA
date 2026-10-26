// Locator for the refuted-candidate shape ratchet
// (src/test-kernel/architecture/refutedCandidatesRatchet.vitest.ts), which
// checks that each refused symbol in config/ratchets/refuted-candidates.json
// can still be found.

/**
 * The line range of a top-level declaration of `symbol`, 1-based and
 * inclusive. Text scanning rather than a parse: the repo is
 * Prettier-formatted, so a top-level declaration starts at column 0 and the
 * line that closes it starts at column 0 too.
 * Throws when the symbol is absent — the ratchet's failure mode is loud, and
 * a symbol that moved is exactly what the baseline update is for.
 */
export function locateSymbol(source, symbol) {
  const lines = source.split('\n');
  const declaration = new RegExp(
    `^(?:export\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:abstract\\s+)?` +
      `(?:function\\s*\\*\\s*|function\\s+|class\\s+|interface\\s+|type\\s+|enum\\s+|const\\s+|let\\s+|var\\s+)` +
      `${symbol}\\b`,
  );
  const startIndex = lines.findIndex((line) => declaration.test(line));
  if (startIndex === -1) {
    throw new Error(`no top-level declaration of \`${symbol}\``);
  }
  if (lines[startIndex].trimEnd().endsWith(';')) {
    return { startLine: startIndex + 1, endLine: startIndex + 1 };
  }
  // The line that closes the declaration holds nothing but closers, so the
  // `)` of a wrapped parameter list (`): Effect.Effect<A> {`) is not mistaken
  // for the end and the body stays inside the range.
  const closeOffset = lines
    .slice(startIndex + 1)
    .findIndex((line) => /^[})\]][\s;,)\]]*$/.test(line));
  if (closeOffset === -1) {
    throw new Error(`declaration of \`${symbol}\` has no closing line`);
  }
  return { startLine: startIndex + 1, endLine: startIndex + closeOffset + 2 };
}
