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
    ' .\n': '.\n',
    ' ,\\nn\\\\\n': ',\\nn\\\\\n',

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

    patterns[':\\colon'] = '\\colon';
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

// Deprecated font commands (e.g., {\rm X}) to modern equivalents
export const FONT_COMMAND_REPLACEMENTS: ReplacementCategory = {
  name: 'font_commands',
  description: 'Normalize deprecated font commands to modern equivalents',
  isRegex: false,
  patterns: (() => {
    const patterns: { [key: string]: string } = {};
    const letters =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split('');
    letters.forEach((letter) => {
      patterns[`{\\rm ${letter}}`] = `\\mathrm{${letter}}`;
      patterns[`{\\bf ${letter}}`] = `\\mathbf{${letter}}`;
      patterns[`{\\it ${letter}}`] = `\\mathit{${letter}}`;
      patterns[`{\\sf ${letter}}`] = `\\mathsf{${letter}}`;
      patterns[`{\\tt ${letter}}`] = `\\mathtt{${letter}}`;
    });

    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    uppercase.forEach((letter) => {
      patterns[`{\\cal ${letter}}`] = `\\mathcal{${letter}}`;
    });

    return patterns;
  })(),
};

// Unicode character replacements
export const UNICODE_REPLACEMENTS: ReplacementCategory = {
  name: 'unicode',
  description:
    'Fixes for common non-math Unicode characters to LaTeX equivalents or for general cleanup (e.g., removing zero-width spaces). Math-specific Unicode is handled by a separate function within math environments.',
  isRegex: false,
  patterns: {
    // ===== Dash and hyphen replacements (globally safe) =====
    '–': '-', // en dash (U+2013) to ASCII hyphen (U+002D)
    '‑': '-', // non-breaking hyphen (U+2011) to ASCII hyphen (U+002D)
    '—': '-', // em dash (U+2014) to ASCII hyphen (U+002D)
    '‐': '-', // HYPHEN (U+2010) to ASCII hyphen (U+002D)
    // Note: Unicode MINUS SIGN U+2212 ('−') is handled by replaceMathUnicode

    // ===== Quote character replacements (globally safe) =====
    '’': "'", // right single quote (U+2019) / APOSTROPHE (U+02BC) often confusable
    '‘': "'", // left single quote (U+2018)
    '”': "''", // right double quote (U+201D)
    '“': '``', // left double quote (U+201C)
    ʼ: "'", // MODIFIER LETTER APOSTROPHE (U+02BC)
    ʾ: "'", // MODIFIER LETTER RIGHT HALF RING (U+02BE) - sometimes misused as quote
    '՚': "'", // ARMENIAN APOSTROPHE (U+055A) - sometimes misused as quote

    // ===== Spacing and Ellipsis =====
    '\u00A0': '~', // Non-breaking space (U+00A0)
    '\u2026': '...', // Horizontal Ellipsis (U+2026) '…' to three periods
    '\u2000': ' ', // EN QUAD (U+2000)
    '\u2001': ' ', // EM QUAD (U+2001)
    '\u2002': ' ', // EN SPACE (U+2002)
    '\u2003': ' ', // EM SPACE (U+2003)
    '\u2004': ' ', // THREE-PER-EM SPACE (U+2004)
    '\u2005': ' ', // FOUR-PER-EM SPACE (U+2005)
    '\u2006': ' ', // SIX-PER-EM SPACE (U+2006)
    '\u2007': ' ', // FIGURE SPACE (U+2007)
    '\u2008': ' ', // PUNCTUATION SPACE (U+2008)
    '\u2009': ' ', // THIN SPACE (U+2009)
    '\u200A': ' ', // HAIR SPACE (U+200A)
    // '\u2028': '\n', // LINE SEPARATOR (U+2028) - User commented out
    // '\u2029': '\n', // PARAGRAPH SEPARATOR (U+2029) - User commented out

    // ===== Suspicious or Invisible Unicode Characters (to be removed) =====
    '\u00AD': '', // Soft Hyphen (U+00AD)
    '\u180E': '', // Mongolian Vowel Separator (U+180E)
    '\u200B': '', // Zero Width Space (U+200B)
    '\u200C': '', // Zero Width Non-Joiner (U+200C)
    '\u200D': '', // Zero Width Joiner (U+200D)
    '\u200E': '', // Left-to-Right Mark (U+200E)
    '\u200F': '', // Right-to-Left Mark (U+200F)
    '\u202A': '', // Left-to-Right Embedding (U+202A)
    '\u202B': '', // Right-to-Left Embedding (U+202B)
    '\u202C': '', // Pop Directional Formatting (U+202C)
    '\u202D': '', // Left-to-Right Override (U+202D)
    '\u202E': '', // Right-to-Left Override (U+202E)
    '\u2060': '', // Word Joiner (U+2060)
    '\u2066': '', // Left-to-Right Isolate (U+2066)
    '\u2067': '', // Right-to-Left Isolate (U+2067)
    '\u2068': '', // First Strong Isolate (U+2068)
    '\u2069': '', // Pop Directional Isolate (U+2069)
    '\uFEFF': '', // Zero Width No-Break Space (BOM) (U+FEFF)

    // ===== Common Symbols to ASCII or simple representation =====
    '\u2022': '*', // BULLET (U+2022) '•' to asterisk
    // '\u00B9': '1', // SUPERSCRIPT ONE (U+00B9) '¹' to '1'
    // '\u00B2': '2', // SUPERSCRIPT TWO (U+00B2) '²' to '2'
    '\u00BD': '1/2', // VULGAR FRACTION ONE HALF (U+00BD) '½' to '1/2'
    '\u2713': '\\checkmark', // CHECK MARK (U+2713) '✓' to \checkmark
    // '™': '\\texttrademark{}', - User commented out
    // '®': '\\textregistered{}', - User commented out
    // '©': '\\textcopyright{}', - User commented out

    // ===== Accented Latin Characters to LaTeX Commands =====
    '\u00E1': "\\'a", // LATIN SMALL LETTER A WITH ACUTE (U+00E1) 'á'
    '\u00E9': "\\'e", // LATIN SMALL LETTER E WITH ACUTE (U+00E9) 'é'
    '\u00ED': "\\'i", // LATIN SMALL LETTER I WITH ACUTE (U+00ED) 'í' (from general knowledge, not in list)
    '\u00F3': "\\'o", // LATIN SMALL LETTER O WITH ACUTE (U+00F3) 'ó'
    '\u00FA': "\\'u", // LATIN SMALL LETTER U WITH ACUTE (U+00FA) 'ú' (from general knowledge, not in list)
    '\u00E0': '\\`a', // LATIN SMALL LETTER A WITH GRAVE (U+00E0) 'à' (from general knowledge, not in list)
    '\u00E8': '\\`e', // LATIN SMALL LETTER E WITH GRAVE (U+00E8) 'è' (from general knowledge, not in list)
    '\u00EC': '\\`i', // LATIN SMALL LETTER I WITH GRAVE (U+00EC) 'ì' (from general knowledge, not in list)
    '\u00F2': '\\`o', // LATIN SMALL LETTER O WITH GRAVE (U+00F2) 'ò' (from general knowledge, not in list)
    '\u00F9': '\\`u', // LATIN SMALL LETTER U WITH GRAVE (U+00F9) 'ù' (from general knowledge, not in list)
    '\u00E2': '\\^a', // LATIN SMALL LETTER A WITH CIRCUMFLEX (U+00E2) 'â' (from general knowledge, not in list)
    '\u00EA': '\\^e', // LATIN SMALL LETTER E WITH CIRCUMFLEX (U+00EA) 'ê' (from general knowledge, not in list)
    '\u00EE': '\\^i', // LATIN SMALL LETTER I WITH CIRCUMFLEX (U+00EE) 'î' (from general knowledge, not in list)
    '\u00F4': '\\^o', // LATIN SMALL LETTER O WITH CIRCUMFLEX (U+00F4) 'ô'
    '\u00FB': '\\^u', // LATIN SMALL LETTER U WITH CIRCUMFLEX (U+00FB) 'û' (from general knowledge, not in list)
    '\u00E4': '\\"a', // LATIN SMALL LETTER A WITH DIAERESIS (U+00E4) 'ä' (from general knowledge, not in list)
    '\u00EB': '\\"e', // LATIN SMALL LETTER E WITH DIAERESIS (U+00EB) 'ë' (from general knowledge, not in list)
    '\u00EF': '\\"i', // LATIN SMALL LETTER I WITH DIAERESIS (U+00EF) 'ï' (from general knowledge, not in list)
    // '\u00F6': '\\"o', // LATIN SMALL LETTER O WITH DIAERESIS (U+00F6) 'ö'
    '\u00FC': '\\"u', // LATIN SMALL LETTER U WITH DIAERESIS (U+00FC) 'ü' (from general knowledge, not in list)
    '\u00E3': '\\~a', // LATIN SMALL LETTER A WITH TILDE (U+00E3) 'ã'
    '\u00F1': '\\~n', // LATIN SMALL LETTER N WITH TILDE (U+00F1) 'ñ' (from general knowledge, not in list)
    '\u00F5': '\\~o', // LATIN SMALL LETTER O WITH TILDE (U+00F5) 'õ' (from general knowledge, not in list)
    '\u00C1': "\\'A", // LATIN CAPITAL LETTER A WITH ACUTE (U+00C1) 'Á' (from general knowledge, not in list)
    '\u00C9': "\\'E", // LATIN CAPITAL LETTER E WITH ACUTE (U+00C9) 'É' (from general knowledge, not in list)
    '\u00D3': "\\'O", // LATIN CAPITAL LETTER O WITH ACUTE (U+00D3) 'Ó' (from general knowledge, not in list)
    '\u00D4': '\\^O', // LATIN CAPITAL LETTER O WITH CIRCUMFLEX (U+00D4) 'Ô' (from general knowledge, not in list)
    '\u00D6': '\\"O', // LATIN CAPITAL LETTER O WITH DIAERESIS (U+00D6) 'Ö' (from general knowledge, not in list)
    '\u00C3': '\\~A', // LATIN CAPITAL LETTER A WITH TILDE (U+00C3) 'Ã' (from general knowledge, not in list)
    '\u014C': '\\=O', // LATIN CAPITAL LETTER O WITH MACRON (U+014C) 'Ō' (from general knowledge, not in list)
    '\u014D': '\\=o', // LATIN SMALL LETTER O WITH MACRON (U+014D) 'ō'
    '\u00C7': '\\c C', // LATIN CAPITAL LETTER C WITH CEDILLA (U+00C7) 'Ç' (from general knowledge, not in list)
    '\u00E7': '\\c c', // LATIN SMALL LETTER C WITH CEDILLA (U+00E7) 'ç' (from general knowledge, not in list)

    // ===== Homoglyph Normalization (Context dependent, use with care) =====
    '\u043E': 'o', // CYRILLIC SMALL LETTER O (U+043E) 'о' to Latin 'o'
    '\u0435': 'e', // CYRILLIC SMALL LETTER IE (U+0435) 'е' to Latin 'e'
    '\u0430': 'a', // CYRILLIC SMALL LETTER A (U+0430) 'а' to Latin 'a' (from general knowledge, not in list)
    // Add more Cyrillic or other homoglyphs here if needed

    // Other math symbols like arrows (→), degree (°), μ (general), ±, ×, ÷
    // are handled by replaceMathUnicode within math environments.

    // ===== Greek letter replacements (moved by user) =====
    // Fix micro unit symbols with proper math mode
    '$ μs': '$ $\\mu$s', // micro (μ U+03BC) to \mu
    '$ μm': '$ $\\mu$m',
    '$ μA': '$ $\\mu$A',
    '$ μV': '$ $\\mu$V',
    '$ μW': '$ $\\mu$W',
    '$ μT': '$ $\\mu$T',
    '$ μH': '$ $\\mu$H',
    '$ μF': '$ $\\mu$F',
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
      // 'document', // this also replaced xml tags which is also being used!!
      'figure',
      'figure*',
      'axis',
      'tikzpicture',
      'scope',
      // 'output', // this might also be a xml tag?
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
    // '\\end{document}\n\n\\<document name=':
    //   '\\end{document}\\n</document>\\n\\<document name=',
    '\\end{document}\n\\end{document}\n<document name=':
      '\\end{document}\n</document>\n<document name=',
    // '\\end{document}\n\\<document name=':
    //   '\\end{document}\n</document>\n\\<document name=',
    '\\end{latex_document}\n</latex_document>':
      '\\end{document}\n</latex_document>',
    '\\end{document}\n\\end{document}\n</latex_documents>':
      '\\end{document}\n</document>\n</latex_documents>',
    // The following two might be aggressive
    '\\end{document}\n</latex_documents>':
      '\\end{document}\n</document>\n</latex_documents>',
    '\\end{document}\n\n<document name':
      '\\end{document}\n</document>\n\n<document name',
    '\\end{document}\n<document name':
      '\\end{document}\n</document>\n<document name',
    '\\end{document}\n</rebuttal_package>':
      '\\end{document}\n</document>\n</rebuttal_package>',
    '<latex_document>\n```xml<latex_document>': '<latex_document>\n',
    '{\\today}\n\n[Previous':
      '{\\today}\n\n\\begin{document}\n\\makeheader[Previous',

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

    // ===== Debtable one-offs =====
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
    '<rebuttal_package><scratchpad>\n\n<rebuttal_package><scratchpad>':
      '<rebuttal_package><scratchpad>',
  },
};

// ===== Style and Content Improvements =====

export const GPTNESS_REPLACEMENTS: ReplacementCategory = {
  name: 'gptness',
  description: 'GPTness improvements',
  isRegex: false,
  patterns: {
    'delve into': 'discuss',
    'delves into': 'discusses',
    'delving into': 'discussing',
    disparate: 'different',
    disseminates: 'distributes',
    disseminated: 'distributed',
    disseminating: 'distributing',
    dissemination: 'distribution',
    disseminations: 'distributions',
    parsimonious: 'simple',
    embark: 'start',
    realm: 'area',
    intricate: 'complex',
    '"exact"': "``exact''",

    "It's important to note": 'Note that',
    'our exploration': 'our discussion',
    'inter-layer': 'interlayer',
    'Near the 50\\%': 'Near 50\\%',
    'on the order of': 'of the order of',
    'improves consistently': 'consistently improves',
    'with results shown': 'with the results shown',
    'imaginary time evolution': 'imaginary-time evolution',
    showcasing: 'showing',
    'paradigm shift': 'big change',
    envisage: 'imagine',
    parameterizing: 'parametrizing',
    Normalizing: 'Normalizing',
    conditon: 'condition',
    necessitates: 'requires',
    Itô: 'Ito',
    k_BT: 'k_B T',

    // Sophisticated single words (user curated)
    myriad: 'many',
    multitude: 'many',
    amalgamation: 'combination',
    culminate: 'end',
    expedite: 'speed up',
    leverage: 'use',
    commence: 'begin',
    elucidate: 'explain',
    ascertain: 'determine',
    paramount: 'important',
    quintessential: 'essential',
    imperative: 'important',
    peruse: 'read',
    cognizant: 'aware',
    nascent: 'new',
    ostensibly: 'apparently',
    conundrum: 'problem',
    efficacy: 'effectiveness',
    deleterious: 'harmful',
    salient: 'prominent',
    precipitate: 'cause', // as a verb
    ubiquitous: 'common',
    underscore: 'emphasize',
    proffer: 'offer',
    surmise: 'guess',
    burgeon: 'grow',
    expound: 'explain',

    // Sophisticated/Formal GPT Expressions (user curated)
    'it is imperative to': 'we must',
    'it is paramount that': 'it is crucial that',
    'of paramount importance': 'very important',
    'it is incumbent upon us to': 'we should',
    'the crux of the matter is': 'the main point is',
    'in light of the fact that': 'because',
    'by virtue of the fact that': 'because',
    'aforementioned discussion': 'this discussion',
    'in the affirmative': 'yes',
    'in the negative': 'no',
    'serves to illustrate': 'shows',
    'render it necessary to': 'require',
    'exhibits a tendency to': 'tends to',
    'have a bearing on': 'affect',
    'bear resemblance to': 'resemble',
    'in consequence of': 'because of',
    'subsequent to our analysis': 'after our analysis',

    // Additional Formal GPT Expressions based on feedback
    'it stands to reason that': 'it follows that', // or 'logically'
    'at this juncture': 'now', // or 'at this point'
    'in the first instance': 'firstly',
    'for the duration of': 'during',
    'be that as it may': 'however', // or 'despite that'
    // 'in accordance with': 'according to', // or 'following'
    'make endeavors to': 'try to',
    'is indicative of': 'indicates',
    'holds true for': 'applies to',
    'bring to fruition': 'complete', // or 'achieve'

    // Top GPT-isms (marketing/cliche phrases)
    'dive deeper into': 'study',
    'harness the power': 'use',
    'seamlessly integrate': 'integrate',
    'leveraging the capabilities': 'using',
    'ultimate guide to': 'guide to',
    'mastering the art of': 'learning',
    'empower you to': 'help you',
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
    '\\mathrm{KL}': '\\KL',

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
    'form \\cref': 'from \\cref',
    ' ~\\citep{': ' \\citep{',
    ' ~\\citet{': ' \\citet{',
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
