import { ReplacementCategory } from './replacementTypes';
import {
  generateGroupedBackslashFixes,
  generateReferenceSpacing,
  generateEnvironmentLinebreakFixes,
  generateXmlLatexConversions,
  generateLatexToXmlConversions,
  generateEnvironmentBracesFixes,
  generateSectionSpacingFixes,
  GREEK_LETTERS,
  SECTION_TYPES,
  MATH_OPERATORS,
} from './replacementHelpers';

// LaTeX spacing and punctuation fixes
export const LATEX_SPACING_REPLACEMENTS: ReplacementCategory = {
  name: 'latex_spacing',
  description:
    'Fixes for LaTeX spacing, punctuation, and formatting [for O1 model]',
  isRegex: false,
  patterns: {
    // ===== Basic spacing fixes =====
    // Remove unnecessary spacing commands
    ' \\;': ' ',
    ', \\;': ', ',
    '\\;': ' ',
    ' \\; ': ' ',
    '\\,\n': '\n',
    '\\!\\!': '',

    // Line breaks and indentation fixes
    ' \\,\\nn': ' \\nn',
    '\n    \\\\': '\\\\',
    ' nn\n': ' \\nn\n',

    // Multiple space fixes
    '.  ': '. ',

    // ===== Comma spacing fixes =====
    ',\\,\\': ', ',
    ')\\,\\': ') \\',
    '}\\,\\': '} \\',
    '|\\,\\': '| \\',
    ' \\,\\': ' \\',

    // ===== Operator spacing =====
    '\\;+\\;': '+',
    '\\;-\\;': '-',
    '\\;*\\;': '*',
    '\\;/\\;': '/',
    '\\;=\\;': '=',
    '+\\;': '+',
    '-\\;': '-',
    '=\\;': '=',

    // ===== Align environment formatting =====
    '\n    \\nonumber\\\\': '\\nonumber\\\\',
    '\n    +': ' +',
    '\n    \n&=': '\n    &=',
    '\n    ,\n': ',\n',
    '\!\n    ': '\n    ',
    '\n    =\n': ' =',
    '\n    \propto\n': ' =',
    '\n     &\n    -': '\n    & -',
    '(\n    ': '(',
    '\n    )': ')',
    '\n     &\n    \\times': '\n    & \\times',

    // ===== Complex math expression spacing =====
    // Exponential expressions
    'e^{\\,i\\,': 'e^{i ',
    'e^{\\,': 'e^{',
    '-\\,i\\, ': '-i ',
    '-\\,i\\,': '-i',
    '\\,i\\,': ' i ',

    // Negative sign handling
    '-\\,': '-',
    '\\,&': ' &',
    '{-\\,0}': '{0}',
    '{-\\,1}': '{1}',

    // ===== Symbol separator handling =====
    // Vertical bars and other delimiters
    ')\!\|': ') \|',
    '}\!\|': '} \|',
    ')\!\\': ') \\',
    '}\!\\': '} \\',

    // Math operator spacing
    '\!\\cdot\!': ' \\cdot ',
    '\!\\ldots\!': ' \\ldots ',
    '\!\\cdots\!': ' \\cdots ',
    '\!\\vdots\!': ' \\vdots ',
    '\!\\ddots\!': ' \\ddots ',

    // ===== Vertical spacing commands =====
    // Remove unnecessary skip commands
    '\\medskip\n': '',
    '\\smallskip\n': '',
    '\\bigskip\n': '',

    // ===== Math mode punctuation =====
    // Move punctuation outside math mode
    '.$': '$.',
    // ',$': '$,', // this is problematic for eg. tikz figure xticklabels={$-\Sig$,0$,\Sig$},
    '$-\\,': '$-',

    // ===== Delimiter simplification =====
    '\\left[\\dots\\right]': '[\\dots]',

    // ===== Display style commands =====
    '\\displaystyle': '',
    '\\Longleftrightarrow': '\\LRa',

    // ===== O1/O3 model specific fixes =====
    '=    \\': '= \\',
    ' rho_': '  \\rho_',
    ' rho^': '  \\rho^',
    ' rho\\': '  \\rho\\',

    // ===== Math limits formatting =====
    '\\sum\\limits_': '\\sum_',
  },
};

// Common LaTeX equation spacing fixes
export const EQUATION_REPLACEMENTS: ReplacementCategory = {
  name: 'equations',
  description: 'Fixes for LaTeX equation spacing and formatting',
  isRegex: false,
  patterns: (() => {
    // Initialize patterns object for auto-generated items
    const patterns: { [key: string]: string } = {};

    // ====================================================================
    // Auto-generated replacements - for easily maintainable pattern groups
    // ====================================================================

    // ===== Environment spacing fixes =====
    // Examples:
    // \n\n\begin{align} -> \n\begin{align}
    // \end{equation}\n\n -> \end{equation}\n
    // const envSpacingPatterns = generateEnvironmentSpacingFixes(
    //   MATH_ENVIRONMENTS.slice(0, 2),
    // );
    // Object.assign(patterns, envSpacingPatterns);
    // This is too aggressive

    // ===== Linebreak fixes within environments =====
    // Examples:
    // \n\n\end{align} -> \n\end{align}
    // \n    \n\end{aligned} -> \n\end{aligned}
    const linebreakFixesPatterns = generateEnvironmentLinebreakFixes(
      'align aligned'.split(' '),
    );
    Object.assign(patterns, linebreakFixesPatterns);

    // ===== Reference formatting =====
    // Examples:
    // figure \ref{ -> figure~\ref{
    // Table \ref{ -> Table~\ref{
    const referencePatterns = generateReferenceSpacing([
      'Figure',
      'figure',
      'Table',
      'table',
      'Eq.',
      'Eqs.',
      'Eqns.',
      'equation',
      'eq.',
      'eqn.',
    ]);
    Object.assign(patterns, referencePatterns);

    // ===== Grouped backslash fixes =====
    // Use the new grouped helper to organize the backslash fixes logically
    const groupedBackslashPatterns = generateGroupedBackslashFixes({
      mathOperators: MATH_OPERATORS.concat(['pi', 'bna']),
      greekLetters: GREEK_LETTERS.concat([
        'partial',
        'Delta',
        'Gamma',
        'Lambda',
        'Sigma',
        'Omega',
      ]),
      delimiters: 'left right left( right( left[ right['.split(' '),
      mathCommands: 'frac sum_ prod_ int_ oint_ nabla'.split(' '),
      integrals: 'int iint iiint oint ooint ooooint'.split(' '),
      dots: 'cdot dot ldots cdots vdots ddots iddots'.split(' '),
      formattingCommands: `
        mathbf mathbb mathcal mathscr bm 
        sum prod lim infty rightarrow leftarrow Rightarrow
        Leftarrow exists forall der partial Delta Gamma Lambda Sigma Omega
      `
        .trim()
        .split(/\s+/),
      formattingWithBraces: `
        text{ tilde{ textit{ textbf{ emph{ underline{
        overbrace{ underbrace{ label{
      `
        .trim()
        .split(/\s+/),
    });
    Object.assign(patterns, groupedBackslashPatterns);

    // Greek letter notation fixes
    // Examples:
    // \a_ -> a_
    // \a^ -> a^
    // \x^ -> x^ [this should not be included]
    const letters = 'abcdefghijklmnopqrstuvwyz'.split('');
    letters.forEach((letter) => {
      patterns[`\\${letter}_`] = `${letter}_`;
      patterns[`\\${letter}^`] = `${letter}^`;
    });

    // ===== Environment end command fixes =====
    // Examples:
    // \n\\nend{align} -> \n\end{align}
    // \n\\nend{document} -> \n\end{document}
    const environments =
      'align equation itemize enumerate figure tikzpicture document'.split(' ');
    environments.forEach((env) => {
      patterns[`\n\\\nend{${env}}`] = `\n\\end{${env}}`;
    });

    // ===== Environment braces/brackets fixes =====
    // Examples:
    // {\align} -> {align}
    // {\document} -> {document}
    const bracesEnvironments =
      'align equation itemize enumerate figure tikzpicture document'.split(' ');
    const bracesFixes = generateEnvironmentBracesFixes(bracesEnvironments);
    Object.assign(patterns, bracesFixes);

    // ===================================================================
    // Manual replacements - for specific cases that need special handling
    // ===================================================================

    // Note: latexdiff compatibility fixes moved to dedicated LATEXDIFF_REPLACEMENTS category

    // Additional specific Greek letter fixes
    patterns['\\\\\\rho'] = '\\rho';
    patterns['\\\\\\delta'] = '\\delta';

    // Additional specific fixes for rho
    patterns['\\\\rho_'] = '\\rho_';
    patterns['\\\\rho^'] = '\\rho^';
    patterns['\\\\rho\\'] = '\\rho\\';

    // Fix line breaks in delimiters
    patterns['\\right\n)'] = '\\right)';
    patterns['\\right\n]'] = '\\right]';
    patterns['\\right\n}'] = '\\right}';
    patterns['\\left\n('] = '\\left(';
    patterns['\\left\n['] = '\\left[';
    patterns['\\left\n{'] = '\\left{';

    // Fix variable notations with wrong backslashes
    patterns['\\\\e^'] = 'e^';

    // Label spacing fixes
    patterns[',    \\label{'] = ',\\label{';
    patterns[',  \\label{'] = ',\\label{';
    patterns[',        \\label{'] = ',\\label{';
    patterns['\\\nlabel{'] = '\\label{';

    // Environment name fixes
    patterns['\\end{Galign}'] = '\\end{align}';

    // Unusual line/paragraph separators (Gemini problem)
    patterns['/[\u2028\u2029]/g'] = '\n';

    return patterns;
  })(),
};

// Section spacing fixes
export const SECTION_REPLACEMENTS: ReplacementCategory = {
  name: 'sections',
  description: 'Fixes for section spacing in LaTeX documents',
  isRegex: false,
  patterns: (() => {
    // Examples:
    // \end{align}\n\section -> \end{align}\n\n\n\section
    // \end{equation}\n\paragraph -> \end{equation}\n\n\n\paragraph
    const environments = ['align', 'equation'];

    return generateSectionSpacingFixes(environments, SECTION_TYPES.slice(0, 3));
  })(),
};

// Special character replacements
export const CHARACTER_REPLACEMENTS: ReplacementCategory = {
  name: 'characters',
  description: 'Fixes for special characters and diacritics',
  isRegex: false,
  patterns: {
    ansätze: 'ans{\\"a}tze',
    Rényi: "R{\\'e}nyi",
    Schrödinger: 'Schr{\\"o}dinger',
  },
};

// Unicode character replacements
export const UNICODE_REPLACEMENTS: ReplacementCategory = {
  name: 'unicode',
  description: 'Fixes for Unicode characters that might cause issues in LaTeX',
  isRegex: false,
  patterns: {
    // ===== Dash and hyphen replacements =====
    // Convert Unicode dashes to ASCII hyphen
    '–': '-', // en dash (U+2013) to hyphen (U+002D)
    '‑': '-', // non-breaking hyphen (U+2011) to hyphen (U+002D)
    '—': '-', // em dash (U+2014) to hyphen (U+002D)
    '−': '-', // minus (U+2212) to hyphen (U+002D)

    // ===== Greek letter replacements =====
    // Fix micro unit symbols with proper math mode
    '$ μs': '$ $\\mu$s', // micro (μ) to \mu
    '$ μm': '$ $\\mu$m',
    '$ μA': '$ $\\mu$A',
    '$ μV': '$ $\\mu$V',
    '$ μW': '$ $\\mu$W',
    '$ μT': '$ $\\mu$T',
    '$ μH': '$ $\\mu$H',
    '$ μF': '$ $\\mu$F',
    // μ: '$\\mu$', // standalone micro symbol

    // ===== Quote character replacements =====
    // Convert Unicode quotes to ASCII quotes
    '\u2019': "'", // right single quote (U+2019) to ASCII single quote
    '\u2018': "'", // left single quote (U+2018) to ASCII single quote
    '\u201D': "''", // right double quote (U+201D) to ASCII double quote
    '\u201C': '``', // left double quote (U+201C) to ASCII double quote
  },
};

// ===== XML/Structural Formatting =====

// XML structure fixes specifically for output processing
export const LATEX_XML_REPLACEMENTS: ReplacementCategory = {
  name: 'latex_xml',
  description: 'Fixes specific to XML output processing',
  isRegex: false,
  patterns: (() => {
    // ====================================================================
    // Auto-generated replacements - for easily maintainable pattern groups
    // ====================================================================

    // Lists of environment/tag names
    const latexEnvironments = [
      'document',
      'figure',
      'figure*',
      'tikzpicture',
      'scope',
      'output',
      'response',
      'itemize',
      'enumerate',
      'equation',
      'align',
      'align*',
      'aligned',
      'aligned*',
      'alignat',
      'alignat*',
      'gather',
      'gather*',
      'section',
      'subsection',
      'referee',
      'array',
      'equation*',
      'minipage',
    ];

    // Pure XML tags that should not be treated as LaTeX environments
    const pureXmlTags = [
      'revised_statement',
      'latex_document',
      'scratchpad',
      'idea',
      'cover_letter',
      'reflection',
      'rebuttal_package',
    ];

    // Initialize patterns object
    const patterns: { [key: string]: string } = {};

    // ===== XML to LaTeX conversions =====
    // Examples:
    // <align> -> \begin{align}
    // </tikzpicture> -> \end{tikzpicture}
    // <figure}> -> \begin{figure}
    const xmlToLatexPatterns = generateXmlLatexConversions(latexEnvironments);
    Object.assign(patterns, xmlToLatexPatterns);

    // ===== LaTeX to XML conversions =====
    // Examples:
    // \begin{scratchpad} -> <scratchpad>
    // \end{latex_document} -> </latex_document>
    const latexToXmlPatterns = generateLatexToXmlConversions(pureXmlTags);
    Object.assign(patterns, latexToXmlPatterns);

    // ===================================================================
    // Manual replacements - for specific cases that need special handling
    // ===================================================================

    // ===== 1. LATEX TAG ENDING FIXES =====
    // Fix LaTeX tags with incorrect XML-style ending (with '>')
    latexEnvironments.forEach((env) => {
      patterns[`\\end{${env}>}`] = `\\end{${env}}`;
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

    return patterns;
  })(),
};

// Document structure, code blocks, and cleanup replacements
export const LATEX_DOCUMENT_REPLACEMENTS: ReplacementCategory = {
  name: 'latex_document',
  description: 'Fixes for LaTeX document structure, code blocks, and cleanup',
  isRegex: false,
  patterns: {
    '\\end {': '\\end{',
    '\\begin {': '\\begin{',
    // ===== 7. CODE BLOCK AND DOCUMENT HANDLING =====
    '```latex\n\\documentclass{lecture}':
      '<latex_document>\n\\documentclass{lecture}',
    '```latex\n\\documentclass[': '<latex_document>\n\\documentclass[',
    '<latex_document>\n```latex': '<latex_document>\n',
    'Here is the revised \\LaTeX document.\n\n```latex':
      'Here is the revised \\LaTeX document.\n\n<latex_document>',
    '```latex\n<latex_document>\n': '\n<latex_document>\n',
    '<latex_document>\n<latex_document>': '<latex_document>',
    '<scratchpad>\n<scratchpad>\n': '<scratchpad>\n',
    '<scratchpad>\n```latex\n': '<scratchpad>\n<latex_document>\n',
    '<scratchpad>```latex': '<scratchpad>\n<latex_document>',
    '```\n</scratchpad>\n</latex_document>': '</latex_document>',
    '</latex_document>\n```\n</latex_document>': '</latex_document>\n',
    '</latex_document>\n</latex_document>': '</latex_document>\n',
    '</latex_document>\n\n</latex_document>': '</latex_document>\n',

    // ===== 9. DOCUMENT STRUCTURE FIXES =====
    '\\end{document}\\n\\n\\<document name=':
      '\\end{document}\\n</document>\\n\\<document name=',
    '\\end{document}\\n\\<document name=':
      '\\end{document}\\n</document>\\n\\<document name=',
    '\\end{latex_document}\\n</latex_document>':
      '\\end{document}\\n</latex_document>',
    '\\end{document}\\n</latex_documents>':
      '\\end{document}\\n</document>\\n</latex_documents>',
    '\\end{document}\\n\\n<document name':
      '\\end{document}\\n</document>\\n\\n<document name',
    '\\end{document}\\n<document name':
      '\\end{document}\\n</document>\\n<document name',
    '\\end{document}\\n</rebuttal_package>':
      '\\end{document}\\n</document>\\n</rebuttal_package>',
    '<latex_document>\n```xml<latex_document>': '<latex_document>\n',
    '{\\today}\\n\\n[Previous':
      '{\\today}\\n\\n\\begin{document}\\n\\makeheader[Previous',

    // ===== 11. CLEANUP AND MISCELLANEOUS =====
    '<ctrl96>': '',
    '<document name="">': '<document name="unknown">',
    '<?xml version="1.0" encoding="UTF-8"?>': '',
    '% 1ST_UPDATED_LATEX_DOCUMENT HERE\n': '',
    '% 2ND_UPDATED_LATEX_DOCUMENT HERE\n': '',
    '\\begin{<latex_document>\nalign': '\\begin{align',
    '\\begin{<latex_document>\nequation': '\\begin{equation',
    '\\begin{<latex_document>\nitemize': '\\begin{itemize',
    '\\begin{<latex_document>\nenumerate': '\\begin{enumerate}',
    '\\begin{<latex_document>\nfigure': '\\begin{figure}',
    '\\begin{<latex_document>\ntikzpicture': '\\begin{tikzpicture}',
    '<xml:documents>': '<latex_documents>',
    '</xml:documents>': '</latex_documents>',
    '```xml\n': '',
    '</xml>': '',
    '\\end\n': '\\end{document}\n',
  },
};

export const SCRATCHPAD_XML_REPLACEMENTS: ReplacementCategory = {
  name: 'scratchpad_xml',
  description: 'Fixes for scratchpad XML processing',
  isRegex: false,
  patterns: {
    // Duplicate scratchpad tag fixes - remove redundant tags
    '<scratchpad><scratchpad>': '<scratchpad>',
    '<scratchpad> <scratchpad>': '<scratchpad>',
    '<scratchpad>\n<scratchpad>': '<scratchpad>',
    // Scratchpad to latex_document transitions - ensure proper nesting
    '<scratchpad>\n<latex_document>':
      '<scratchpad>\n</scratchpad>\n<latex_document>',
    '<scratchpad><latex_document>':
      '<scratchpad>\n</scratchpad>\n<latex_document>',
    '<scratchpad><cover_letter>': '<scratchpad>\n</scratchpad>\n<cover_letter>',
    '<scratchpad>\n<cover_letter>':
      '<scratchpad>\n</scratchpad>\n<cover_letter>',
    // Code block to latex_document conversions - handle markdown code blocks
    '<scratchpad>\n```latex\n<latex_document>':
      '<scratchpad>\n</scratchpad>\n<latex_document>',
    '</scratchpad>\n```latex': '</scratchpad>\n<latex_document>',
    '</scratchpad>\n\n```latex': '</scratchpad>\n\n<latex_document>',
    '</scratchpad>\n    \n```latex': '</scratchpad>\n\n<latex_document>',
    '```\n</latex_document>': '</latex_document>',
    // Special LaTeX content handling
    '</scratchpad>\n\\section{':
      '</scratchpad>\n\\<latex_document>\n\\section{',
    '</scratchpad>\n\\begin{document}':
      '</scratchpad>\n\\<latex_document>\n\\begin{document}',
    // Rebuttal package fixes
    '<rebuttal_package><scratchpad>\n\\n<rebuttal_package><scratchpad>':
      '<rebuttal_package><scratchpad>',
  },
};

// ===== Style and Content Improvements =====

export const STYLE_REPLACEMENTS: ReplacementCategory = {
  name: 'style',
  description: 'Style improvements and word choice fixes',
  isRegex: false,
  patterns: {
    delve: 'discuss',
    embark: 'start',
    realm: 'area',
    intricate: 'complex',
    '"exact"': "``exact''",
    'delving into': 'discussing',
    "It's important to note": 'Note that',
    'our exploration': 'our discussion',
    'inter-layer': 'interlayer',
    'Near the 50\\%': 'Near 50\\%',
    'on the order of': 'of the order of',
    'improves consistently': 'consistently improves',
    'with results shown': 'with the results shown',
    'imaginary time evolution': 'imaginary-time evolution',
    // 'underscores': ''
    showcasing: 'showing',
    'paradigm shift': 'big change',
    envisage: 'imagine',
    // typos
    parameterizing: 'parametrizing',
    Normalizing: 'Normalizing',
    // thermodynamical: 'thermodynamic', // problematic with thermodynamically
    conditon: 'condition',
    necessitates: 'requires',
    Itô: 'Ito',
    k_BT: 'k_B T',
  },
};

// Personal writing style preferences
export const PERSONAL_STYLE_REPLACEMENTS: ReplacementCategory = {
  name: 'personal_style',
  description:
    'Personal writing style preferences for specific LaTeX commands and spacing',
  isRegex: false,
  patterns: {
    // ===== Spacing preferences =====
    // Consistent spacing for math mode and delimiters
    '\\;': ' ',
    ' \\, d\\': '~ d\\',
    ' \\,|': ' |',
    '|\\, ': '| ',
    ' \\,  ': ' ',
    '  \\, ': ' ',
    ' \\, ': ' ',
    '\\, \\,': ' \\,',
    // '\\,': ' ',

    // ===== Hyphenation and compound term preferences =====
    // Physical Review style compound term formatting
    nonnegative: 'non-negative',
    finitetime: 'finite-time',
    'one–step': 'one-step',
    'multi-scale': 'multiscale',
    'area law scaling': 'area-law scaling',
    'machine learning model': 'machine-learning model',
    'machine learning task': 'machine-learning task',

    // ===== Spelling standardization =====
    // Convert UK to US spelling
    analogue: 'analog',

    // ===== Reference formatting =====
    // Add non-breaking spaces for references (chktex compatibility)
    'Appendix \\ref{': 'Appendix~\\ref{',
    'Section \\ref{': 'Section~\\ref{',
    'Figure \\ref{': 'Figure~\\ref{',
    'Table \\ref{': 'Table~\\ref{',
    'Equation \\ref{': 'Equation~\\ref{',
    'Theorem \\ref{': 'Theorem~\\ref{',
    'Lemma \\ref{': 'Lemma~\\ref{',
    'Corollary \\ref{': 'Corollary~\\ref{',

    // ===== Math operator standardization =====
    // Preferred operator command forms
    '\\mathrm{tr}': '\\tr',
    '\\mathrm{Tr}': '\\Tr',

    // ===== Reference formatting =====
    // Add non-breaking spaces for references (chktex compatibility)
    'in~\\cref{': 'in \\cref{',
    'In~\\cref{': 'In \\cref{',
    'in~Sec': 'in Sec',
    'In~Sec': 'In Sec',
    'by~Eq': 'by Eq',
    'by~Eqs': 'by Eqs',
    'by~Eqs.': 'by Eqs.',
    'see~Sec': 'see Sec',
    'See~Sec': 'See Sec',
    'from~Eq': 'from Eq',
    'From~Eq': 'From Eq',
    'from~Eqs': 'from Eqs',
    'From~Eqs': 'From Eqs',
    'from~Eqs.': 'from Eqs.',
    'From~Eqs.': 'From Eqs.',
    'cf.~Eq': 'cf. Eq',
    'to~App': 'to App',
    '~(\\ref{': ' (\\ref{',
  },
};

// ===== LaTeXdiff compatibility fixes =====
export const LATEXDIFF_REPLACEMENTS: ReplacementCategory = {
  name: 'latexdiff',
  description: 'Fixes for LaTeXdiff markup and compatibility issues',
  isRegex: false,
  patterns: {
    // Fix issues with latexdiff markup and excessive newlines
    '\n\n}\\end{align*}%DIFAUXCMD': '\n}\\end{align*}%DIFAUXCMD',
    '\n    \n}\\end{align*}%DIFAUXCMD': '\n}\\end{align*}%DIFAUXCMD',
    '\n\t\n}\\end{align*}%DIFAUXCMD': '\n}\\end{align*}%DIFAUXCMD',
    '\n\n}\\end{aligned*}%DIFAUXCMD': '\n}\\end{aligned*}%DIFAUXCMD',
    '\n    \n}\\end{aligned*}%DIFAUXCMD': '\n}\\end{aligned*}%DIFAUXCMD',
    '\n\t\n}\\end{aligned*}%DIFAUXCMD': '\n}\\end{aligned*}%DIFAUXCMD',
  },
};
