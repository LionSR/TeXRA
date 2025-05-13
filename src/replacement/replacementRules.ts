import { ReplacementCategory } from './replacementTypes';

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
  patterns: {
    // ===== Environment spacing fixes =====
    // Align environment spacing
    '\n\n\\begin{align}': '\n\\begin{align}',
    '\\end{align}\n\n': '\\end{align}\n',
    '\n\n\\begin{equation}': '\n\\begin{equation}',
    '\\end{equation}\n\n': '\\end{equation}\n',

    // ===== Linebreak fixes within environments =====
    // Remove extra newlines in align environments
    '\n\n\\end{align}': '\n\\end{align}',
    '\n    \n\\end{align}': '\n\\end{align}',
    '\n\t\n\\end{align}': '\n\\end{align}',
    '\n\n\\end{aligned}': '\n\\end{aligned}',
    '\n    \n\\end{aligned}': '\n\\end{aligned}',
    '\n\t\n\\end{aligned}': '\n\\end{aligned}',

    // ===== latexdiff compatibility fixes =====
    // Fix issues with latexdiff markup
    '\n\n}\\end{align*}%DIFAUXCMD': '\n}\\end{align*}%DIFAUXCMD',
    '\n    \n}\\end{align*}%DIFAUXCMD': '\n}\\end{align*}%DIFAUXCMD',
    '\n\t\n}\\end{align*}%DIFAUXCMD': '\n}\\end{align*}%DIFAUXCMD',
    '\n\n}\\end{aligned*}%DIFAUXCMD': '\n}\\end{aligned*}%DIFAUXCMD',
    '\n    \n}\\end{aligned*}%DIFAUXCMD': '\n}\\end{aligned*}%DIFAUXCMD',
    '\n\t\n}\\end{aligned*}%DIFAUXCMD': '\n}\\end{aligned*}%DIFAUXCMD',

    // ===== Reference formatting =====
    // Add non-breaking spaces between references and their numbers
    'figure \\ref{': 'figure~\\ref{',
    'table \\ref{': 'table~\\ref{',
    'equation \\ref{': 'equation~\\ref{',
    'Fig. \\ref{': 'Fig.~\\ref{',
    'Table \\ref{': 'Table~\\ref{',
    'Equation \\ref{': 'Equation~\\ref{',
    'eq. \\ref{': 'eq.~\\ref{',
    'eqn. \\ref{': 'eqn.~\\ref{',
    'Eq. \\ref{': 'Eq.~\\ref{',
    'Eqs. \\ref{': 'Eqs.~\\ref{',

    // ===== Math operator command fixes =====
    // Fix incorrect backslashes in math operators
    '\\\\cos': '\\cos',
    '\\\\sin': '\\sin',
    '\\\\tan': '\\tan',
    '\\\\arctan': '\\arctan',
    '\\\\arccos': '\\arccos',
    '\\\\arcsin': '\\arcsin',
    '\\\\log': '\\log',
    '\\\\ln': '\\ln',
    '\\\\exp': '\\exp',
    '\\\\sqrt': '\\sqrt',
    '\\\\pi': '\\pi',
    '\\\\bna': '\\bna',

    // ===== Greek letter command fixes =====
    '\\\\alpha': '\\alpha',
    '\\\\beta': '\\beta',
    '\\\\gamma': '\\gamma',
    '\\\\delta': '\\delta',
    '\\\\epsilon': '\\epsilon',
    '\\\\zeta': '\\zeta',
    '\\\\eta': '\\eta',
    '\\\\theta': '\\theta',
    '\\\\iota': '\\iota',
    '\\\\kappa': '\\kappa',
    '\\\\lambda': '\\lambda',
    '\\\\mu': '\\mu',
    '\\\\nu': '\\nu',
    '\\\\xi': '\\xi',
    '\\\\omicron': '\\omicron',
    '\\\\\\rho': '\\rho',
    '\\\\rho': '\\rho',
    '\\\\\\delta': '\\delta',

    // ===== LaTeX command fixes =====
    // Fix common delimiter commands
    '\\\\left': '\\left',
    '\\\\right': '\\right',
    '\\\\left(': '\\left(',
    '\\\\right(': '\\right(',
    '\\\\left[': '\\left[',
    '\\\\right[': '\\right[',

    // Fix line breaks in delimiters
    '\\right\n)': '\\right)',
    '\\right\n]': '\\right]',
    '\\right\n}': '\\right}',
    '\\left\n(': '\\left(',
    '\\left\n[': '\\left[',
    '\\left\n{': '\\left{',

    // Fix fraction and other math commands
    '\\\\frac': '\\frac',
    '\\\\rho_': '\\rho_',
    '\\\\rho^': '\\rho^',
    '\\\\rho\\': '\\rho\\',
    '\\\\sum_': '\\sum_',
    '\\\\prod_': '\\prod_',
    '\\\\int_': '\\int_',
    '\\\\oint_': '\\oint_',
    '\\\\nabla': '\\nabla',

    // ===== Symbol and dot fixes =====
    '\\\\cdot': '\\cdot',
    '\\\\dot': '\\dot',
    '\\\\ldots': '\\ldots',
    '\\\\cdots': '\\cdots',
    '\\\\vdots': '\\vdots',
    '\\\\ddots': '\\ddots',
    '\\\\int': '\\int',
    '\\\\oint': '\\oint',

    // ===== Math variable naming fixes =====
    // Fix variable notations with wrong backslashes
    '\\\\e^': 'e^',

    // Greek letter notation fixes
    '\\a_': 'a_',
    '\\b_': 'b_',
    '\\c_': 'c_',
    '\\d_': 'd_',
    '\\e_': 'e_',
    '\\f_': 'f_',
    '\\g_': 'g_',
    '\\h_': 'h_',
    '\\i_': 'i_',
    '\\j_': 'j_',
    '\\k_': 'k_',
    '\\l_': 'l_',
    '\\m_': 'm_',
    '\\n_': 'n_',
    '\\o_': 'o_',
    '\\p_': 'p_',
    '\\q_': 'q_',
    '\\r_': 'r_',
    '\\s_': 's_',
    '\\t_': 't_',
    '\\u_': 'u_',
    '\\v_': 'v_',
    '\\w_': 'w_',
    '\\x_': 'x_',
    '\\y_': 'y_',
    '\\z_': 'z_',

    // Letter with superscript fixes
    '\\a^': 'a^',
    '\\b^': 'b^',
    '\\c^': 'c^',
    '\\d^': 'd^',
    '\\e^': 'e^',
    '\\f^': 'f^',
    '\\g^': 'g^',
    '\\h^': 'h^',
    '\\i^': 'i^',
    '\\j^': 'j^',
    '\\k^': 'k^',
    '\\l^': 'l^',
    '\\m^': 'm^',
    '\\n^': 'n^',
    '\\o^': 'o^',
    '\\p^': 'p^',
    '\\q^': 'q^',
    '\\r^': 'r^',
    '\\s^': 's^',
    '\\t^': 't^',
    '\\u^': 'u^',
    '\\v^': 'v^',
    '\\w^': 'w^',
    '\\x^': 'x^',
    '\\y^': 'y^',
    '\\z^': 'z^',

    // ===== Text formatting fixes =====
    '\\\\mathbf': '\\mathbf',
    '\\\\mathbb': '\\mathbb',
    '\\\\mathcal': '\\mathcal',
    '\\\\mathscr': '\\mathscr',
    '\\\\bm': '\\bm',
    '\\\\text{': '\\text{',
    '\\\\tilde{': '\\tilde',
    '\\\\textit{': '\\textit',
    '\\\\textbf{': '\\textbf',
    '\\\\emph{': '\\emph',
    '\\\\underline{': '\\underline',
    '\\\\overbrace{': '\\overbrace',
    '\\\\underbrace{': '\\underbrace',
    // Extra backslashes in commands
    '\\\\sum': '\\sum',
    '\\\\prod': '\\prod',
    '\\\\lim': '\\lim',
    '\\\\infty': '\\infty',
    '\\\\rightarrow': '\\rightarrow',
    '\\\\leftarrow': '\\leftarrow',
    '\\\\Rightarrow': '\\Rightarrow',
    '\\\\Leftarrow': '\\Leftarrow',
    '\\\\exists': '\\exists',
    '\\\\forall': '\\forall',

    // ===== Math differential and operator fixes =====
    '\\e^{': 'e^{',
    '\\\\\\der': '\\der',
    '\\\\der': '\\der',
    '\\\\partial': '\\partial',
    '\\\\Delta': '\\Delta',
    '\\\\Gamma': '\\Gamma',
    '\\\\Lambda': '\\Lambda',
    '\\\\Sigma': '\\Sigma',
    '\\\\Omega': '\\Omega',

    // ===== Label fixes =====
    ',    \\label{': ',\\label{',
    ',  \\label{': ',\\label{',
    ',        \\label{': ',\\label{',
    '\\\\label{': '\\label{',
    '\\\nlabel{': '\\label{',

    // ===== Environment name fixes =====
    '\\end{Galign}': '\\end{align}',

    // ===== Environment end command fixes =====
    '\n\\\nend{align}': '\n\\end{align}',
    '\n\\\nend{equation}': '\n\\end{equation}',
    '\n\\\nend{itemize}': '\n\\end{itemize}',
    '\n\\\nend{enumerate}': '\n\\end{enumerate}',
    '\n\\\nend{figure}': '\n\\end{figure}',
    '\n\\\nend{tikzpicture}': '\n\\end{tikzpicture}',
    '\n\\\nend{document}': '\n\\end{document}',

    // ===== Environment braces/brackets fixes =====
    '{\\align}': '{align}',
    '{\\equation}': '{equation}',
    '{\\itemize}': '{itemize}',
    '{\\enumerate}': '{enumerate}',
    '{\\figure}': '{figure}',
    '{\\tikzpicture}': '{tikzpicture}',
    '{\\document}': '{document}',

    // Unusal line/paragraph separators (Gemini problem)
    '/[\u2028\u2029]/g': '\n',
  },
};

// Section spacing fixes
export const SECTION_REPLACEMENTS: ReplacementCategory = {
  name: 'sections',
  description: 'Fixes for section spacing in LaTeX documents',
  isRegex: false,
  patterns: {
    '\\end{align}\n\\section': '\\end{align}\n\n\n\\section',
    '\\end{equation}\n\\section': '\\end{equation}\n\n\n\\section',
    '\\end{align}\n\\subsection': '\\end{align}\n\n\n\\subsection',
    '\\end{equation}\n\\subsection': '\\end{equation}\n\n\n\\subsection',
    '\\end{align}\n\\paragraph': '\\end{align}\n\n\n\\paragraph',
    '\\end{equation}\n\\paragraph': '\\end{equation}\n\n\n\\paragraph',
  },
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
    '’': "'", // right single quote (U+2019) to ASCII single quote
    '‘': "'", // left single quote (U+2018) to ASCII single quote
    '”': "''", // right double quote (U+201D) to ASCII double quote
    '“': '``', // left double quote (U+201C) to ASCII double quote
  },
};

// ===== XML/Structural Formatting =====

// XML structure fixes specifically for output processing
export const LATEX_XML_REPLACEMENTS: ReplacementCategory = {
  name: 'latex_xml',
  description: 'Fixes specific to XML output processing',
  isRegex: false,
  patterns: (() => {
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

    // ===== 3. XML-TO-LATEX CONVERSIONS =====
    // Special cases for minipage
    patterns['\\minipage}'] = '\\end{minipage}';
    patterns['\\n\\minipage}'] = '\\n\\end{minipage}';

    // Special case for item tag
    patterns['<item>'] = '\\item';
    patterns['</item>'] = '';

    // Convert LaTeX environments when used as XML tags to LaTeX environments
    latexEnvironments.forEach((env) => {
      patterns[`<${env}>`] = `\\begin{${env}}`;
      patterns[`</${env}>`] = `\\end{${env}}`;

      // ===== 4. XML-TO-LATEX CONVERSIONS WITH BRACES =====
      // Fix XML tags with extra braces that should be LaTeX environments
      patterns[`<${env}}`] = `\\begin{${env}}`;
      patterns[`</${env}}`] = `\\end{${env}}`;
    });

    // ===== 5. LaTeX-TO-XML TAG CONVERSIONS =====
    // Convert LaTeX environments to XML tags for the pure XML tags
    pureXmlTags.forEach((tag) => {
      patterns[`\\begin{${tag}}`] = `<${tag}>`;
      patterns[`\\end{${tag}}`] = `</${tag}>`;
      // Also handle common error case with '>' at the end
      patterns[`\\begin{${tag}>}`] = `<${tag}>`;
      patterns[`\\end{${tag}>}`] = `</${tag}>`;
    });

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
