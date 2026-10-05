/**
 * Brace-balanced scanner for LaTeX-style macro calls with a fixed number of
 * `{...}` arguments (e.g. `\foo{a}{b}{c}`). Unlike a fixed-depth regex (which
 * can only match a bounded number of nested `{...}` levels inside each
 * argument), this walks brace depth explicitly, so arguments containing
 * arbitrarily nested macros (`\criticize{see \sqrt{\frac{a}{b}}}{2}{3}`)
 * still match correctly.
 */

export interface BraceMacroCall {
  /** Each argument's raw text (delimiting braces stripped). */
  readonly args: string[];
  /** Index of the macro's leading backslash. */
  readonly start: number;
  /** Index just past the last argument's closing brace. */
  readonly end: number;
}

function readBraceGroup(
  source: string,
  index: number,
): { content: string; end: number } | null {
  if (source[index] !== '{') return null;
  let depth = 1;
  let i = index + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\' && i + 1 < source.length) {
      // Skip escaped character (handles `\{`, `\}`, `\\`)
      i += 2;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return { content: source.slice(index + 1, i), end: i + 1 };
      }
    }
    i++;
  }
  return null;
}

function skipWhitespace(source: string, index: number): number {
  let i = index;
  while (i < source.length && /\s/.test(source[i])) i++;
  return i;
}

/**
 * Find every brace-balanced `macroName{arg1}...{argN}` call in `source`.
 * Optional whitespace is allowed between the macro name and each argument,
 * and between arguments. A call is only recognized once all `argCount`
 * groups are present and brace-balanced; a macro name immediately followed
 * by another letter (e.g. `\criticizeFoo` when scanning for `\criticize`) is
 * skipped as a partial match rather than a call.
 */
export function findBraceBalancedMacroCalls(
  source: string,
  macroName: string,
  argCount: number,
): BraceMacroCall[] {
  const out: BraceMacroCall[] = [];
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const macroAt = source.indexOf(macroName, searchFrom);
    if (macroAt === -1) break;

    const afterMacro = source[macroAt + macroName.length];
    if (afterMacro && /[A-Za-z]/.test(afterMacro)) {
      searchFrom = macroAt + macroName.length;
      continue;
    }

    const args: string[] = [];
    let cursor = macroAt + macroName.length;
    for (let i = 0; i < argCount; i++) {
      const group = readBraceGroup(source, skipWhitespace(source, cursor));
      if (!group) break;
      args.push(group.content);
      cursor = group.end;
    }

    // A call is only recognized when all argCount groups were present; either
    // way, scanning resumes past the last consumed group.
    if (args.length === argCount) {
      out.push({ args, start: macroAt, end: cursor });
    }
    searchFrom = cursor;
  }
  return out;
}
