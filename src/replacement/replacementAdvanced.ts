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
    μ: '\\mu', // mu
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
    '−': '-', // minus sign
    '×': '\\times', // multiplication
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
    // '√': '\\sqrt{}', // square root (with closed brace for safety)
    // '∛': '\\sqrt[3]{}', // cube root
    '∠': '\\angle', // angle
    '⊥': '\\perp', // perpendicular
    '∥': '\\parallel', // parallel
    '∧': '\\wedge', // logical and
    '∨': '\\vee', // logical or
    '¬': '\\neg', // logical not
    '⇒': '\\Rightarrow', // implies
    '⇔': '\\Leftrightarrow', // if and only if
    '↑': '\\uparrow', // up arrow
    '↓': '\\downarrow', // down arrow
    '←': '\\leftarrow', // left arrow
    '→': '\\rightarrow', // right arrow
    '↔': '\\leftrightarrow', // left-right arrow
    '⟨': '\\langle', // left angle bracket
    '⟩': '\\rangle', // right angle bracket
    '…': '\\ldots', // horizontal ellipsis
    '⋅': '\\cdot', // center dot
    '⋮': '\\vdots', // vertical ellipsis
    '⋯': '\\cdots', // center ellipsis
    '⋱': '\\ddots', // diagonal ellipsis
    '°': '^{\\circ}', // degree
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
  let inlineMathPattern = /\$(.*?)\$/g;
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
