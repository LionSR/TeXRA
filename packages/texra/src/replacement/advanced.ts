/**
 * Utilities for managing text replacements in the codebase.
 */

import {
  GREEK_LETTER_CHARACTERS,
  UPPERCASE_GREEK_LETTER_CHARACTERS,
} from '@replacement/constants';
import { findBraceBalancedMacroCalls } from '@texra/utils/text/braceBalancedMacro';

/**
 * A fact a replacement pass reports rather than logs: the passes are pure, so
 * the program that runs them writes these on its own log.
 */
export interface ReplacementDiagnostic {
  readonly level: 'debug' | 'error';
  readonly message: string;
}

/**
 * Applies LaTeX quotes formatting to a LaTeX document.
 * Converts regular double quotes to LaTeX-style quotes (``'') for quoted text
 * that is between 3 and 16 characters long, while avoiding:
 * - Text within tikzpicture environments
 * - Escaped quotes like those in Schr{\"o}dinger
 * - Quotes within braces like in {\"o}
 *
 * @param text LaTeX document text
 * @returns Text with quotes replaced, and the narration of what changed
 */
export function applyLatexQuotesFormatting(text: string): {
  readonly text: string;
  readonly diagnostics: readonly ReplacementDiagnostic[];
} {
  // Fast path: nothing to do without a document block containing a quote.
  if (!text.includes('\\begin{document}') || !text.includes('"')) {
    return { text, diagnostics: [] };
  }

  const diagnostics: ReplacementDiagnostic[] = [];
  const debug = (message: string): void => {
    diagnostics.push({ level: 'debug', message });
  };
  debug('Starting LaTeX quotes formatting');

  // Extract document content (everything between \begin{document} and \end{document})
  const documentRegex = /\\begin\{document\}([\s\S]*?)\\end\{document\}/g;
  let documentCount = 0;
  let totalReplacements = 0;

  // Process each document block separately; replaceAll rebuilds the result in
  // one pass instead of splicing the full text per block.
  const processedText = text.replaceAll(
    documentRegex,
    (_fullMatch, documentContent: string) => {
      documentCount++;

      // Store tikzpicture environments to avoid processing them
      const tikzEnvironments: string[] = [];
      const tikzRegex = /\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/g;
      let tikzCounter = 0;

      // Replace tikzpicture environments with placeholders
      const contentWithoutTikz = documentContent.replaceAll(
        tikzRegex,
        (tikzMatchStr: string) => {
          const placeholder = `__TIKZ_PLACEHOLDER_${tikzCounter++}__`;
          tikzEnvironments.push(tikzMatchStr);
          return placeholder;
        },
      );

      debug(`Removed ${tikzCounter} tikzpicture environments`);

      // Process quotes in the remaining content
      let replacementCount = 0;
      const processedContent = contentWithoutTikz.replaceAll(
        /(?<!\\"|\{)"([^"]{3,16})"(?!\})/g,
        (_match, quotedText) => {
          replacementCount++;
          debug(`Converting quote: "${quotedText}" → \`\`${quotedText}''`);
          return `\`\`${quotedText}''`;
        },
      );

      debug(
        `Made ${replacementCount} quote replacements in document #${documentCount}`,
      );
      totalReplacements += replacementCount;

      // Restore tikzpicture environments. The function replaceValue is
      // required: a string replaceValue applies $-substitution, so a stashed
      // body containing $& / $$ / $` / $' would splice the placeholder back
      // into the document instead of being restored verbatim.
      const restoredContent = tikzEnvironments.reduce(
        (content, env, i) =>
          content.replace(`__TIKZ_PLACEHOLDER_${i}__`, () => env),
        processedContent,
      );

      return `\\begin{document}${restoredContent}\\end{document}`;
    },
  );

  debug(
    `Finished LaTeX quotes formatting: processed ${documentCount} document blocks, made ${totalReplacements} replacements`,
  );

  return { text: processedText, diagnostics };
}

/**
 * Escapes bare underscores inside \texttt commands so they compile correctly.
 *
 * Each \texttt{...} span is processed independently and underscores that are
 * already escaped are preserved so the helper is idempotent.
 */
export function escapeTextttUnderscores(text: string): string {
  // (?<!\\)_ matches underscore not preceded by backslash
  // This ensures we don't double-escape already escaped underscores
  return text.replaceAll(
    /\\texttt\{([^}]*)\}/g,
    (_, content: string) =>
      `\\texttt{${content.replaceAll(/(?<!\\)_/g, '\\_')}}`,
  );
}

// Map of Unicode characters to their LaTeX equivalents
const MATH_UNICODE_MAP: Record<string, string> = {
  // Greek letters: α -> \alpha, Δ -> \Delta. LaTeX has no \omicron, so ο
  // is left as written.
  ...Object.fromEntries(
    Object.entries({
      ...GREEK_LETTER_CHARACTERS,
      ...UPPERCASE_GREEK_LETTER_CHARACTERS,
    })
      .filter(([name]) => name !== 'omicron')
      .map(([name, char]) => [char, `\\${name}`]),
  ),
  µ: '\\mu', // U+00B5 MICRO SIGN, beside the Greek mu

  // Operators, relations, arrows and dots. Look-alikes listed separately:
  // the minus sign U+2212, both parallels U+2225 and U+2016, both dots
  // U+22C5 and U+00B7, and the increment U+2206 beside Greek Delta.
  '−': '-',
  '×': '\\times',
  '÷': '\\div',
  '≤': '\\leq',
  '≥': '\\geq',
  '≠': '\\neq',
  '≈': '\\approx',
  '≡': '\\equiv',
  '≅': '\\cong',
  '∼': '\\sim',
  '∝': '\\propto',
  '≺': '\\prec',
  '≻': '\\succ',
  '⊂': '\\subset',
  '⊃': '\\supset',
  '⊆': '\\subseteq',
  '⊇': '\\supseteq',
  '∈': '\\in',
  '∉': '\\notin',
  '∋': '\\ni',
  '∩': '\\cap',
  '∪': '\\cup',
  '∅': '\\emptyset',
  '∞': '\\infty',
  '∇': '\\nabla',
  '∂': '\\partial',
  '∫': '\\int',
  '∬': '\\iint',
  '∭': '\\iiint',
  '∮': '\\oint',
  '∑': '\\sum',
  '∏': '\\prod',
  '∠': '\\angle',
  '⊥': '\\perp',
  '∥': '\\parallel',
  '‖': '\\parallel',
  '∧': '\\wedge',
  '∨': '\\vee',
  '¬': '\\neg',
  '⇒': '\\Rightarrow',
  '⇔': '\\Leftrightarrow',
  '↑': '\\uparrow',
  '↓': '\\downarrow',
  '←': '\\leftarrow',
  '→': '\\rightarrow',
  '↔': '\\leftrightarrow',
  '⟨': '\\langle',
  '⟩': '\\rangle',
  '…': '\\ldots',
  '⋅': '\\cdot',
  '·': '\\cdot',
  '⋮': '\\vdots',
  '⋯': '\\cdots',
  '⋱': '\\ddots',
  '°': '^{\\circ}',
  '′': '\\prime',
  '∗': '\\ast',
  '∘': '\\circ',
  '∆': '\\Delta',
  '⌊': '\\lfloor',
  '⌋': '\\rfloor',

  // Letter-like symbols. The double-struck N maps to \mathcal{N}, not
  // \mathbb{N}, by choice.
  ℝ: '\\mathbb{R}',
  ℕ: '\\mathcal{N}',
  ℓ: '\\ell',
  𝒜: '\\mathcal{A}',
  ℬ: '\\mathcal{B}',
  𝒞: '\\mathcal{C}',
  𝒟: '\\mathcal{D}',
  ℰ: '\\mathcal{E}',
  ℱ: '\\mathcal{F}',
  𝒢: '\\mathcal{G}',
  ℋ: '\\mathcal{H}',
  ℐ: '\\mathcal{I}',
  ℒ: '\\mathcal{L}',
  ℳ: '\\mathcal{M}',
  𝒩: '\\mathcal{N}',
  𝒪: '\\mathcal{O}',
  𝒫: '\\mathcal{P}',
  𝒬: '\\mathcal{Q}',
  ℛ: '\\mathcal{R}',
  𝒮: '\\mathcal{S}',
  𝒯: '\\mathcal{T}',
  𝒰: '\\mathcal{U}',
  𝒱: '\\mathcal{V}',
  𝒲: '\\mathcal{W}',
  𝒳: '\\mathcal{X}',
  𝒴: '\\mathcal{Y}',
  𝒵: '\\mathcal{Z}',
  𝒙: '\\mathbf{x}',
  𝒇: '\\mathbf{f}',

  // Subscripts and superscripts.
  '₀': '_{0}',
  '₁': '_{1}',
  '₂': '_{2}',
  ₐ: '_{a}',
  ₓ: '_{x}',
  ₜ: '_{t}',
  ₙ: '_{n}',
  ᵧ: '_{\\gamma}',
  '⁻': '^{-}',
  ⁿ: '^{n}',
  ᵀ: '^{T}',
  ᵐ: '^{m}',
};

// Math environment delimiters to search for
const MATH_ENVIRONMENTS = [
  { start: '\\begin{equation}', end: '\\end{equation}' },
  { start: '\\begin{equation*}', end: '\\end{equation*}' },
  { start: '\\begin{align}', end: '\\end{align}' },
  { start: '\\begin{align*}', end: '\\end{align*}' },
  { start: '\\begin{aligned}', end: '\\end{aligned}' },
  { start: '\\begin{multline}', end: '\\end{multline}' },
  { start: '\\begin{gather}', end: '\\end{gather}' },
  { start: '\\begin{cases}', end: '\\end{cases}' },
  { start: '\\[', end: '\\]' },
  { start: '$$', end: '$$' },
];

/**
 * Single alternation regex over all mapped Unicode characters, so each math
 * segment is converted in one pass instead of one `replaceAll` per map entry
 * (~150 passes). Keys are literal characters (no regex metacharacters), so
 * joining them is safe; the `u` flag keeps astral-plane keys (e.g. 𝒜) intact.
 */
const MATH_UNICODE_REGEX = new RegExp(
  Object.keys(MATH_UNICODE_MAP).join('|'),
  'gu',
);
// Non-global twin for stateless `.test()` probes.
const MATH_UNICODE_PROBE = new RegExp(MATH_UNICODE_REGEX.source, 'u');

/**
 * Convert Unicode characters and HTML sub/sup tags to LaTeX within math content.
 */
function convertMathContent(content: string): string {
  const result = content.replaceAll(
    MATH_UNICODE_REGEX,
    (char) => MATH_UNICODE_MAP[char],
  );
  if (!result.includes('<')) return result;
  return result
    .replaceAll(/<sub>(.*?)<\/sub>/g, '_{$1}')
    .replaceAll(/<sup>(.*?)<\/sup>/g, '^{$1}');
}

/**
 * Helper function to convert Unicode characters to LaTeX commands
 * within math environments only
 */
export function replaceMathUnicode(text: string): string {
  // Fast path: skip the per-environment scans (and the inline `$...$` pass,
  // which reallocates the string even when nothing changes) if the text
  // contains nothing convertMathContent would touch.
  if (
    !MATH_UNICODE_PROBE.test(text) &&
    !text.includes('<sub>') &&
    !text.includes('<sup>')
  ) {
    return text;
  }

  // Process each block math environment
  for (const env of MATH_ENVIRONMENTS) {
    let startIdx = 0;
    while ((startIdx = text.indexOf(env.start, startIdx)) !== -1) {
      const envStart = startIdx + env.start.length;
      const envEnd = text.indexOf(env.end, envStart);

      if (envEnd === -1) {
        startIdx += env.start.length;
        continue;
      }

      const mathContent = text.slice(envStart, envEnd);
      const replacedContent = convertMathContent(mathContent);

      if (replacedContent !== mathContent) {
        text = text.slice(0, envStart) + replacedContent + text.slice(envEnd);
      }

      startIdx = envStart + replacedContent.length;
    }
  }

  // Handle inline math with $ ... $
  return text.replaceAll(
    /\$(.*?)\$/g,
    (_, p1: string) => `$${convertMathContent(p1)}$`,
  );
}

/**
 * Fix orientation of LaTeX-style quotes and adjust punctuation placement.
 * Only processes well-formed quoted segments to avoid affecting apostrophes.
 */
export function fixLatexQuoteIssues(text: string): string {
  // ''text'' -> ``text''
  // But avoid modifying text that's already in the format ``text''
  text = text.replaceAll(/(?<!`)''([a-zA-Z\s]{3,16})''(?!`)/g, "``$1''");

  // 'text' -> `text'
  // Only for single quotes that aren't already in the format `text'
  text = text.replaceAll(/(?<![\w`])'([a-zA-Z\s]{3,16})'(?![\w'])/g, "`$1'");

  // Move punctuation outside closing double quotes
  text = text.replaceAll(/(``[a-zA-Z\s]{3,16})([.,;:])('')(.*)/g, "$1''$2$4");

  // Move punctuation outside closing single quotes
  text = text.replaceAll(/(`[a-zA-Z\s]{3,16})([.,;:])(')/g, "$1'$2");

  return text;
}

const CRITICIZE_MACRO = '\\criticize';

/**
 * Strip all `\criticize{comment}{severity}{confidence}` LaTeX annotations
 * (inserted by critique-style agents) from LaTeX content. Uses the same
 * brace-balanced macro scanner as `parseCriticismAnnotations` (the
 * extension's `frontend/latex/criticismParser.ts`) so a message containing nested macros (e.g.
 * `\cref{...}`, `\frac{a}{b}`) is stripped correctly rather than left
 * behind. Unlike `parseCriticismAnnotations`, this applies no
 * severity/confidence validation — malformed annotations still need to be
 * removed from output.
 */
export function stripCriticizeAnnotations(content: string): {
  content: string;
  count: number;
} {
  if (!content.includes(CRITICIZE_MACRO)) return { content, count: 0 };
  const calls = findBraceBalancedMacroCalls(content, CRITICIZE_MACRO, 3);
  if (calls.length === 0) return { content, count: 0 };

  let out = '';
  let cursor = 0;
  // Tracks the start of the line containing the current call, advanced
  // forward as `calls` (already in ascending `start` order) are walked —
  // avoids a `lastIndexOf` backward-scan per call, which would be
  // O(document length) per annotation on a document with no preceding
  // newline (e.g. one long generated/minified line).
  let lineStart = 0;
  for (const call of calls) {
    let nextNewline = content.indexOf('\n', lineStart);
    while (nextNewline !== -1 && nextNewline < call.start) {
      lineStart = nextNewline + 1;
      nextNewline = content.indexOf('\n', lineStart);
    }
    const nlIndex = content.indexOf('\n', call.end);
    const lineEnd = nlIndex === -1 ? content.length : nlIndex;
    const beforeOnLine = content.slice(lineStart, call.start);
    const afterOnLine = content.slice(call.end, lineEnd);
    // Whole-line form is removed along with its trailing newline so a macro
    // occupying its own line doesn't leave a blank line behind.
    const isWholeLine =
      /^[ \t]*$/.test(beforeOnLine) && /^[ \t]*\r?$/.test(afterOnLine);

    if (isWholeLine) {
      out += content.slice(cursor, lineStart);
      cursor = nlIndex === -1 ? content.length : nlIndex + 1;
    } else {
      out += content.slice(cursor, call.start);
      cursor = call.end;
    }
  }
  out += content.slice(cursor);
  return { content: out, count: calls.length };
}

/**
 * Wrap bare \critique and \comment commands in align environments with \intertext.
 * Handles simple nested braces within critique/comment content.
 *
 * @param text LaTeX document text
 * @returns Text with \critique and \comment commands wrapped in \intertext within align blocks
 */
const ALIGN_BLOCK_RE = /\\begin\{align\*?\}[\s\S]*?\\end\{align\*?\}/g;
// One precompiled regex per wrapped command — bare instances not already
// inside \intertext.
const BARE_COMMAND_RES = (['critique', 'comment'] as const).map(
  (cmd) =>
    [
      new RegExp(`(?<!\\\\intertext{)\\\\${cmd}{((?:[^{}]|{[^{}]*})*)}`, 'g'),
      `\\intertext{\\${cmd}{$1}}`,
    ] as const,
);

export function wrapCritiqueInAlign(text: string): string {
  return text.replaceAll(ALIGN_BLOCK_RE, (block) => {
    for (const [regex, replacement] of BARE_COMMAND_RES) {
      block = block.replace(regex, replacement);
    }
    return block;
  });
}
