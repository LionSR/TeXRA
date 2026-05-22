// Local imports - replacement
import {
  generateXmlLatexConversions,
  generateLatexToXmlConversions,
  LATEX_ENVIRONMENTS,
} from '@replacement/helpers';
import { ReplacementCategory } from '@replacement/types';

export const LATEX_XML_REPLACEMENTS: ReplacementCategory = {
  name: 'latex_xml',
  description: 'Fixes specific to XML output processing',
  isRegex: false,
  patterns: (() => {
    // ====================================================================
    // Auto-generated replacements - for easily maintainable pattern groups
    // ====================================================================

    // Lists of environment/tag names
    const latexEnvironments = LATEX_ENVIRONMENTS;

    // Pure XML tags that should not be treated as LaTeX environments.
    // Note: `latex_document` is intentionally NOT here — all of its
    // normalization lives in `latex_document` (latexDocument.ts) so the
    // legacy wrapper has a single owner.
    const pureXmlTags = [
      'revised_statement',
      'scratchpad',
      'idea',
      'cover_letter',
      'reflection',
      'rebuttal_package',
      'beamer_poster',
    ];

    // ===== XML to LaTeX conversions =====
    // Examples:
    // <align> -> \begin{align}
    // </tikzpicture> -> \end{tikzpicture}
    // <figure}> -> \begin{figure}
    const xmlToLatexPatterns = generateXmlLatexConversions(latexEnvironments);

    // ===== LaTeX to XML conversions =====
    // Examples:
    // \begin{scratchpad} -> <scratchpad>
    // \end{latex_document} -> </latex_document>
    const latexToXmlPatterns = generateLatexToXmlConversions(pureXmlTags);

    // Initialize patterns object with generated conversions
    const patterns: { [key: string]: string } = {
      ...xmlToLatexPatterns,
      ...latexToXmlPatterns,
    };

    // ===================================================================
    // Manual replacements - for specific cases that need special handling
    // ===================================================================

    // ===== 1. LATEX TAG ENDING FIXES =====
    // Fix LaTeX tags with incorrect XML-style ending (with '>')
    latexEnvironments.forEach((env) => {
      patterns[`\\end{${env}>}`] = `\\end{${env}}`;
      patterns[`\\end{${env}>`] = `\\end{${env}}`;
      patterns[`</end{${env}>`] = `\\end{${env}}`;
    });

    // ===== 2. XML BRACE FIXES =====
    // Fix XML tags with extra braces that remain as XML
    pureXmlTags.forEach((tag) => {
      patterns[`<${tag}}`] = `<${tag}>`;
      patterns[`</${tag}}`] = `</${tag}>`;
    });

    // ===== 3. Special Case Handling =====
    // Special cases for minipage
    patterns['\\minipage}'] = '\\end{minipage}';
    patterns['\\n\\minipage}'] = '\\n\\end{minipage}';

    // Special case for item tag
    patterns['<item>'] = '\\item';
    patterns['</item>'] = '';

    // ===== 6. LATEX BRACE FIXES =====
    // Fix extra braces in LaTeX environment tags
    patterns['\\begin{figure*}}'] = '\\begin{figure*}';
    patterns['\\begin{figure}}'] = '\\begin{figure}';

    // ===== 7. Unified <documents><document name="..."> hygiene =====
    // Empty name attribute breaks the named-document fallback in extraction.
    patterns['<document name="">'] = '<document name="unknown">';

    // ===== 8. Stray XML noise emitted by some models =====
    patterns['<?xml version="1.0" encoding="UTF-8"?>'] = '';
    patterns['```xml\n'] = '';
    patterns['</xml>'] = '';

    return patterns;
  })(),
};
