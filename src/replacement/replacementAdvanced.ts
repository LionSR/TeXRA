/**
 * Utilities for managing text replacements in the codebase.
 */

// Local imports - log
import * as logger from '../logger/logUtils';

// Import vscode workspace configuration
import { getConfig } from '../utils/configUtils';

const CHANNEL = 'ReplacementUtils';
logger.initialize(CHANNEL);

import { ReplacementCategory } from './replacementTypes';

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
  logger.debug(CHANNEL, 'Starting LaTeX quotes formatting');

  // Extract document content (everything between \begin{document} and \end{document})
  const documentRegex = /\\begin\{document\}([\s\S]*?)\\end\{document\}/g;
  let documentMatch: RegExpExecArray | null;
  let processedText = text;
  let documentCount = 0;
  let totalReplacements = 0;

  // Process each document block separately
  while ((documentMatch = documentRegex.exec(text)) !== null) {
    documentCount++;
    const fullMatch = documentMatch[0];
    const documentContent = documentMatch[1];
    const startIndex = documentMatch.index;
    const endIndex = startIndex + fullMatch.length;

    // logger.debug(CHANNEL, `Processing document block #${documentCount}`);

    // Store tikzpicture environments to avoid processing them
    const tikzEnvironments: string[] = [];
    const tikzRegex = /\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/g;
    let tikzCounter = 0;

    // Replace tikzpicture environments with placeholders
    const contentWithoutTikz = documentContent.replace(
      tikzRegex,
      (tikzMatchStr: string) => {
        const placeholder = `__TIKZ_PLACEHOLDER_${tikzCounter++}__`;
        tikzEnvironments.push(tikzMatchStr);
        return placeholder;
      },
    );

    logger.debug(CHANNEL, `Removed ${tikzCounter} tikzpicture environments`);

    // Process quotes in the remaining content
    let replacementCount = 0;
    const processedContent = contentWithoutTikz.replace(
      /(?<!\\"|\{)"([^"]{3,16})"(?!\})/g,
      (_match, quotedText) => {
        replacementCount++;
        logger.debug(
          CHANNEL,
          `Converting quote: "${quotedText}" → \`\`${quotedText}''`,
        );
        return `\`\`${quotedText}''`;
      },
    );

    logger.debug(
      CHANNEL,
      `Made ${replacementCount} quote replacements in document #${documentCount}`,
    );
    totalReplacements += replacementCount;

    // Restore tikzpicture environments
    let restoredContent = processedContent;
    for (let i = 0; i < tikzEnvironments.length; i++) {
      restoredContent = restoredContent.replace(
        `__TIKZ_PLACEHOLDER_${i}__`,
        tikzEnvironments[i],
      );
    }

    // Replace the current document block with the processed one
    const processedDocumentBlock = `\\begin{document}${restoredContent}\\end{document}`;
    processedText =
      processedText.substring(0, startIndex) +
      processedDocumentBlock +
      processedText.substring(endIndex);

    // Update regex lastIndex to account for any changes in string length
    const lengthDifference = processedDocumentBlock.length - fullMatch.length;
    documentRegex.lastIndex += lengthDifference;
  }

  logger.debug(
    CHANNEL,
    `Finished LaTeX quotes formatting: processed ${documentCount} document blocks, made ${totalReplacements} replacements`,
  );

  return processedText;
}

/**
 * Helper function to convert Unicode characters to LaTeX commands
 * within math environments only
 */
export function replaceMathUnicode(text: string): string {
  // Map of Unicode characters to their LaTeX equivalents
  const mathUnicodeMap: { [key: string]: string } = {
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

  // Environment patterns to search for
  const mathEnvironments = [
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

  // Process each math environment
  for (const env of mathEnvironments) {
    let startIdx = 0;
    // Continue searching for math environments from where we left off
    while ((startIdx = text.indexOf(env.start, startIdx)) !== -1) {
      const envStart = startIdx + env.start.length;
      const envEnd = text.indexOf(env.end, envStart);

      // If we can't find the end, skip this instance
      if (envEnd === -1) {
        startIdx += env.start.length;
        continue;
      }

      // Extract the content of the math environment
      const mathContent = text.substring(envStart, envEnd);

      // Apply Unicode replacements within the math content
      let replacedContent = mathContent;

      // Replace Unicode characters with LaTeX commands
      for (const [unicode, latex] of Object.entries(mathUnicodeMap)) {
        replacedContent = replacedContent.replace(
          new RegExp(unicode, 'g'),
          latex,
        );
      }

      // Replace HTML subscript tags with LaTeX subscript syntax
      replacedContent = replacedContent.replace(/<sub>(.*?)<\/sub>/g, '_{$1}');

      // Replace HTML superscript tags with LaTeX superscript syntax
      replacedContent = replacedContent.replace(/<sup>(.*?)<\/sup>/g, '^{$1}');

      // Replace the original math content with the processed one
      if (replacedContent !== mathContent) {
        text =
          text.substring(0, envStart) +
          replacedContent +
          text.substring(envEnd);
      }

      // Move past this environment
      startIdx = envStart + replacedContent.length;
    }
  }

  // Also handle inline math with $ ... $
  const inlineMathPattern = /\$(.*?)\$/g;
  text = text.replace(inlineMathPattern, (match, p1) => {
    let content = p1;

    // Replace Unicode characters with LaTeX commands
    for (const [unicode, latex] of Object.entries(mathUnicodeMap)) {
      content = content.replace(new RegExp(unicode, 'g'), latex);
    }

    // Replace HTML subscript tags with LaTeX subscript syntax
    content = content.replace(/<sub>(.*?)<\/sub>/g, '_{$1}');

    // Replace HTML superscript tags with LaTeX superscript syntax
    content = content.replace(/<sup>(.*?)<\/sup>/g, '^{$1}');

    return '$' + content + '$';
  });

  return text;
}

/**
 * Fix orientation of LaTeX-style quotes and adjust punctuation placement.
 * Only processes well-formed quoted segments to avoid affecting apostrophes.
 */
export function fixLatexQuoteIssues(text: string): string {
  // ''text'' -> ``text''
  text = text.replace(/''([^']+?)''/g, "``$1''");

  // 'text' -> `text'
  text = text.replace(/(?<![\w])'([^']+?)'(?![\w])/g, "`$1'");

  // Move punctuation outside closing double quotes
  text = text.replace(/(``[^']+?)([.,;:])''/g, "$1''$2");

  // Move punctuation outside closing single quotes
  text = text.replace(/(`[^']+?)([.,;:])'/g, "$1'$2");

  return text;
}
