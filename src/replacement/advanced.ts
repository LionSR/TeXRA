/**
 * Utilities for managing text replacements in the codebase.
 */

// Local imports - log
import { createLog } from '@logger/logUtils';
import { findBraceBalancedMacroCalls } from '@utils/text/braceBalancedMacro';

const log = createLog('ReplacementEngine');

/**
 * Applies LaTeX quotes formatting to a LaTeX document.
 * Converts regular double quotes to LaTeX-style quotes (``'') for quoted text
 * that is between 3 and 15 characters long, while avoiding:
 * - Text within tikzpicture environments
 * - Escaped quotes like those in Schr{\"o}dinger
 * - Quotes within braces like in {\"o}
 *
 * @param text LaTeX document text
 * @returns Text with quotes replaced
 */
export function applyLatexQuotesFormatting(text: string): string {
  // Fast path: nothing to do without a document block containing a quote.
  if (!text.includes('\\begin{document}') || !text.includes('"')) {
    return text;
  }

  log.debug('Starting LaTeX quotes formatting');

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

      log.debug(`Removed ${tikzCounter} tikzpicture environments`);

      // Process quotes in the remaining content
      let replacementCount = 0;
      const processedContent = contentWithoutTikz.replaceAll(
        /(?<!\\"|\{)"([^"]{3,16})"(?!\})/g,
        (_match, quotedText) => {
          replacementCount++;
          log.debug(`Converting quote: "${quotedText}" → \`\`${quotedText}''`);
          return `\`\`${quotedText}''`;
        },
      );

      log.debug(
        `Made ${replacementCount} quote replacements in document #${documentCount}`,
      );
      totalReplacements += replacementCount;

      // Restore tikzpicture environments
      const restoredContent = tikzEnvironments.reduce(
        (content, env, i) => content.replace(`__TIKZ_PLACEHOLDER_${i}__`, env),
        processedContent,
      );

      return `\\begin{document}${restoredContent}\\end{document}`;
    },
  );

  log.debug(
    `Finished LaTeX quotes formatting: processed ${documentCount} document blocks, made ${totalReplacements} replacements`,
  );

  return processedText;
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
  // Greek letters (alphabetical)
  α: '\\alpha', // alpha
  β: '\\beta', // beta
  χ: '\\chi', // chi
  δ: '\\delta', // delta
  Δ: '\\Delta', // Delta
  ε: '\\epsilon', // epsilon
  η: '\\eta', // eta
  γ: '\\gamma', // gamma
  Γ: '\\Gamma', // Gamma
  ι: '\\iota', // iota
  κ: '\\kappa', // kappa
  λ: '\\lambda', // lambda
  Λ: '\\Lambda', // Lambda
  μ: '\\mu', // mu (U+03BC GREEK SMALL LETTER MU)
  µ: '\\mu', // mu (U+00B5 MICRO SIGN)
  ν: '\\nu', // nu
  ω: '\\omega', // omega
  Ω: '\\Omega', // Omega
  φ: '\\phi', // phi
  Φ: '\\Phi', // Phi
  π: '\\pi', // pi
  Π: '\\Pi', // Pi
  ψ: '\\psi', // psi
  Ψ: '\\Psi', // Psi
  ρ: '\\rho', // rho
  σ: '\\sigma', // sigma
  Σ: '\\Sigma', // Sigma
  τ: '\\tau', // tau
  θ: '\\theta', // theta
  Θ: '\\Theta', // Theta
  υ: '\\upsilon', // upsilon
  Υ: '\\Upsilon', // Upsilon
  ξ: '\\xi', // xi
  Ξ: '\\Xi', // Xi
  ζ: '\\zeta', // zeta

  // Mathematical operators and symbols
  '−': '-', // minus sign (U+2212)
  '×': '\\times', // multiplication (U+00D7 or U+22C2)
  '÷': '\\div', // division
  '≤': '\\leq', // less than or equal
  '≥': '\\geq', // greater than or equal
  '≠': '\\neq', // not equal
  '≈': '\\approx', // approximately equal
  '≡': '\\equiv', // equivalent to
  '≅': '\\cong', // congruent to
  '∼': '\\sim', // similar to
  '∝': '\\propto', // proportional to
  '≺': '\\prec', // precedes
  '≻': '\\succ', // succeeds
  '⊂': '\\subset', // subset
  '⊃': '\\supset', // superset
  '⊆': '\\subseteq', // subset or equal
  '⊇': '\\supseteq', // superset or equal
  '∈': '\\in', // element of
  '∉': '\\notin', // not element of
  '∋': '\\ni', // contains as member
  '∩': '\\cap', // intersection
  '∪': '\\cup', // union
  '∅': '\\emptyset', // empty set
  '∞': '\\infty', // infinity
  '∇': '\\nabla', // nabla
  '∂': '\\partial', // partial derivative
  '∫': '\\int', // integral
  '∬': '\\iint', // double integral
  '∭': '\\iiint', // triple integral
  '∮': '\\oint', // contour integral
  '∑': '\\sum', // summation
  '∏': '\\prod', // product
  // '√': '\\sqrt{}', // square root (U+221A)
  // '∛': '\\sqrt[3]{}', // cube root
  '∠': '\\angle', // angle
  '⊥': '\\perp', // perpendicular
  '∥': '\\parallel', // parallel (U+2225)
  '‖': '\\parallel', // parallel (U+2016, alternative)
  '∧': '\\wedge', // logical and
  '∨': '\\vee', // logical or
  '¬': '\\neg', // logical not
  '⇒': '\\Rightarrow', // implies (U+21D2)
  '⇔': '\\Leftrightarrow', // if and only if (U+21D4)
  '↑': '\\uparrow', // up arrow
  '↓': '\\downarrow', // down arrow
  '←': '\\leftarrow', // left arrow
  '→': '\\rightarrow', // right arrow
  '↔': '\\leftrightarrow', // left-right arrow
  '⟨': '\\langle', // left angle bracket
  '⟩': '\\rangle', // right angle bracket
  '…': '\\ldots', // horizontal ellipsis
  '⋅': '\\cdot', // center dot (U+22C5)
  '·': '\\cdot', // middle dot (U+00B7, alternative)
  '⋮': '\\vdots', // vertical ellipsis
  '⋯': '\\cdots', // center ellipsis
  '⋱': '\\ddots', // diagonal ellipsis
  '°': '^{\\circ}', // degree
  '′': '\\prime', // prime (U+2032)
  '∗': '\\ast', // asterisk operator (U+2217)
  '∘': '\\circ', // ring operator (U+2218)
  '∆': '\\Delta', // increment / Laplacian (U+2206, distinct from Greek Delta U+0394 but often maps to \Delta)
  '⌊': '\\lfloor', // left floor (U+230A)
  '⌋': '\\rfloor', // right floor (U+230B)

  // Letter-like Symbols
  ℝ: '\\mathbb{R}', // double-struck R (U+211D)
  ℕ: '\\mathcal{N}', // User mapped DOUBLE-STRUCK CAPITAL N (U+2115) to \mathcal{N}
  ℓ: '\\ell', // script small l (U+2113)
  '𝒜': '\\mathcal{A}', // script A (U+1D49C MATHEMATICAL SCRIPT CAPITAL A)
  ℬ: '\\mathcal{B}', // script B (U+212C SCRIPT CAPITAL B)
  // 'ℭ': '\\mathcal{C}', // User mapped BLACK-LETTER CAPITAL C (U+212D) to \mathcal{C}
  '𝒞': '\\mathcal{C}', // script C (U+1D49E MATHEMATICAL SCRIPT CAPITAL C)
  '𝒟': '\\mathcal{D}', // script D (U+1D49F MATHEMATICAL SCRIPT CAPITAL D)
  ℰ: '\\mathcal{E}', // script E (U+2130 SCRIPT CAPITAL E)
  ℱ: '\\mathcal{F}', // script F (U+2131 SCRIPT CAPITAL F)
  '𝒢': '\\mathcal{G}', // script G (U+1D4A2 MATHEMATICAL SCRIPT CAPITAL G)
  ℋ: '\\mathcal{H}', // script H (U+210B SCRIPT CAPITAL H)
  ℐ: '\\mathcal{I}', // script I (U+2110 SCRIPT CAPITAL I)
  ℒ: '\\mathcal{L}', // script L (U+2112 SCRIPT CAPITAL L)
  ℳ: '\\mathcal{M}', // script M (U+2133 SCRIPT CAPITAL M)
  '𝒩': '\\mathcal{N}', // script N (U+1D4A5 MATHEMATICAL SCRIPT CAPITAL N)
  '𝒪': '\\mathcal{O}', // script O (U+1D4A6 MATHEMATICAL SCRIPT CAPITAL O)
  '𝒫': '\\mathcal{P}', // script P (U+1D4A9 MATHEMATICAL SCRIPT CAPITAL P)
  '𝒬': '\\mathcal{Q}', // script Q (U+1D4AA MATHEMATICAL SCRIPT CAPITAL Q)
  ℛ: '\\mathcal{R}', // script R (U+211B SCRIPT CAPITAL R)
  '𝒮': '\\mathcal{S}', // script S (U+1D4AE MATHEMATICAL SCRIPT CAPITAL S)
  '𝒯': '\\mathcal{T}', // script T (U+1D4AF MATHEMATICAL SCRIPT CAPITAL T)
  '𝒰': '\\mathcal{U}', // script U (U+1D4B0 MATHEMATICAL SCRIPT CAPITAL U)
  '𝒱': '\\mathcal{V}', // script V (U+1D4B1 MATHEMATICAL SCRIPT CAPITAL V)
  '𝒲': '\\mathcal{W}', // script W (U+1D4B2 MATHEMATICAL SCRIPT CAPITAL W)
  '𝒳': '\\mathcal{X}', // script X (U+1D4B3 MATHEMATICAL SCRIPT CAPITAL X)
  '𝒴': '\\mathcal{Y}', // script Y (U+1D4B4 MATHEMATICAL SCRIPT CAPITAL Y)
  '𝒵': '\\mathcal{Z}', // script Z (U+1D4B5 MATHEMATICAL SCRIPT CAPITAL Z)
  '𝒙': '\\mathbf{x}', // bold x (U+1D499)
  '𝒇': '\\mathbf{f}', // bold f (U+1D487)

  // Unicode Subscripts/Superscripts to LaTeX
  '₀': '_{0}', // subscript 0 (U+2080)
  '₁': '_{1}', // subscript 1 (U+2081)
  '₂': '_{2}', // subscript 2 (U+2082)
  ₐ: '_{a}', // subscript a (U+2090)
  // '₋': '_{-S}', // subscript minus (U+208B) - User commented out, LaTeX has no standard subscript minus
  // '₍': '_{(}', // subscript left parenthesis (U+208D)
  // '₎': '_{)}', // subscript right parenthesis (U+208E)
  ₓ: '_{x}', // subscript x (U+2093)
  ₜ: '_{t}', // subscript t (U+209C)
  ₙ: '_{n}', // subscript n (U+2099)
  ᵧ: '_{\\gamma}', // subscript gamma (U+1D67)
  '⁻': '^{-}', // superscript minus (U+207B)
  ⁿ: '^{n}', // superscript n (U+207F)
  ᵀ: '^{T}', // superscript T (U+1D40)
  ᵐ: '^{m}', // superscript m (U+1D50)

  // Combining Diacritics (experimental - may need pre-processing for ideal LaTeX)
  // '̇': '\\dot{}', // combining dot above (U+0307) - User commented out
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
  return text.replaceAll(/\$(.*?)\$/g, (_, p1: string) => {
    return `$${convertMathContent(p1)}$`;
  });
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
 * brace-balanced macro scanner as `parseCriticismAnnotations`
 * (`@latex/criticismParser`) so a message containing nested macros (e.g.
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
