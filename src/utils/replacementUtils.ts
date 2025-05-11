/**
 * Utilities for managing text replacements in the codebase.
 */

// Local imports - log
import * as logger from '../logger/logUtils';

// Import vscode workspace configuration
import { getConfig } from '../utils/configUtils';

const CHANNEL = 'ReplacementUtils';
logger.initialize(CHANNEL);

interface ReplacementCategory {
  name: string;
  description: string;
  patterns: { [key: string]: string };
  isRegex?: boolean;
  flags?: string; // Optional regex flags
}

// ===== LaTeX Content Formatting =====

// LaTeX spacing and punctuation fixes
const LATEX_SPACING_REPLACEMENTS: ReplacementCategory = {
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
const EQUATION_REPLACEMENTS: ReplacementCategory = {
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
    '\n\n}\\end{align*}%DIFAUXCMD': '\n\\end{align*}%DIFAUXCMD',
    '\n    \n}\\end{align*}%DIFAUXCMD': '\n\\end{align*}%DIFAUXCMD',
    '\n\t\n}\\end{align*}%DIFAUXCMD': '\n\\end{align*}%DIFAUXCMD',
    '\n\n}\\end{aligned*}%DIFAUXCMD': '\n\\end{aligned*}%DIFAUXCMD',
    '\n    \n}\\end{aligned*}%DIFAUXCMD': '\n\\end{aligned*}%DIFAUXCMD',
    '\n\t\n}\\end{aligned*}%DIFAUXCMD': '\n\\end{aligned*}%DIFAUXCMD',

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
const SECTION_REPLACEMENTS: ReplacementCategory = {
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
const CHARACTER_REPLACEMENTS: ReplacementCategory = {
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
const UNICODE_REPLACEMENTS: ReplacementCategory = {
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
    μ: '$\\mu$', // standalone micro symbol

    // ===== Quote character replacements =====
    // Convert Unicode quotes to ASCII quotes
    '’': "'", // right single quote (U+2019) to ASCII single quote
    '‘': "'", // left single quote (U+2018) to ASCII single quote
    '”': "''", // right double quote (U+201D) to ASCII double quote
    '“': '``', // left double quote (U+201C) to ASCII double quote

    // ===== Other common Unicode symbol replacements =====
    // Commented out as they might be too aggressive
    // '…': '\\ldots', // ellipsis (U+2026) to \ldots
    // '×': '$\\times$', // multiplication (U+00D7) to \times
    // '÷': '$\\div$', // division (U+00F7) to \div
    // '≤': '$\\leq$', // less than or equal (U+2264) to \leq
    // '≥': '$\\geq$', // greater than or equal (U+2265) to \geq
    // '≠': '$\\neq$', // not equal (U+2260) to \neq
    // '≈': '$\\approx$', // approximately equal (U+2248) to \approx
    // '∞': '$\\infty$', // infinity (U+221E) to \infty
    // '°': '$^{\\circ}$', // degree (U+00B0) to ^{\circ}
    // '′': "'", // prime (U+2032) to ASCII single quote
    // '″': '"', // double prime (U+2033) to ASCII double quote
    // '√': '$\\sqrt{}$', // square root (U+221A) to \sqrt{}
    // '∫': '$\\int$', // integral (U+222B) to \int
    // '∑': '$\\sum$', // sum (U+2211) to \sum
    // '∏': '$\\prod$', // product (U+220F) to \prod
  },
};

// ===== XML/Structural Formatting =====

// XML structure fixes specifically for output processing
const LATEX_XML_REPLACEMENTS: ReplacementCategory = {
  name: 'latex_xml',
  description: 'Fixes specific to XML output processing',
  isRegex: false,
  patterns: {
    // ===== Random tag fixes =====
    '<ctrl96>': '',
    // \end{document> etc is a real mistake that need to be fixed!!! Do not change these
    // ===== Basic tag ending fixes =====
    // Fix missing/incorrect closing tags
    '\\end{document>': '\\end{document}',
    '\\end{figure>': '\\end{figure}',
    '\\end{tikzpicture>': '\\end{tikzpicture}',
    '\\end{scope>': '\\end{scope}',
    '\\end{output>': '\\end{output}',
    '\\end{response>': '\\end{response}',
    '\\end{itemize>': '\\end{itemize}',
    '\\end{enumerate>': '\\end{enumerate}',
    '\\end{equation>': '\\end{equation}',
    '\\end{align>': '\\end{align}',
    '\\end{section>': '\\end{section}',
    '\\end{subsection>': '\\end{subsection}',

    // ===== XML to LaTeX tag conversion =====
    '\\end{revised_statement>': '</revised_statement>',
    '\\end{latex_document>': '</latex_document>\n',
    '\\enc{reflection>': '</reflection>',
    '\\end{scratchpad>': '</scratchpad>',
    '\\end{referee>': '\\end{referee}',

    // // \equation> etc
    // '\\equation>': '\\end{equation}',
    // '\\align>': '\\end{align}',
    // '\\itemize>': '\\end{itemize}',
    // '\\enumerate>': '\\end{enumerate}',
    // '\\figure>': '\\end{figure}',
    // '\\tikzpicture>': '\\end{tikzpicture}',
    // '\\scope>': '\\end{scope}',
    // '\\revised_statement>': '</revised_statement>',
    // '\\latex_document>': '</latex_document>',

    // ===== Gemini-specific reference format problems =====
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

    // ===== Minipage and figure environment fixes =====
    '</minipage>': '\\end{minipage}',
    '\\begin{figure*}}': '\\begin{figure*}',
    '\\begin{figure}}': '\\begin{figure}',
    '\n\\minipage}': '\n\\end{minipage}',
    '\\minipage}': '\\end{minipage}',
    // LaTeX to XML conversions
    '\\end{idea}': '</idea>',
    '\\end{scratchpad}': '</scratchpad>',
    '\\end\n': '\\end{document}\n',
    '</figure>\n': '\\end{figure}\n',
    '</enumerate>': '\\end{enumerate}',
    '<itemize>': '\\begin{itemize}',
    '</itemize>': '\\end{itemize}',
    '<item>': '\\item',
    '</item>': '',

    // ===== Math environment XML-LaTeX conversions =====
    '<align>': '\\begin{align}',
    '</align>': '\\end{align}',
    '<equation>': '\\begin{equation}',
    '</equation>': '\\end{equation}',
    '<tikzpicture>': '\\begin{tikzpicture}',
    '</tikzpicture>': '\\end{tikzpicture}',
    '<figure>': '\\begin{figure}',
    '</figure>': '\\end{figure}',
    '<section>': '\\begin{section}',
    '</section>': '\\end{section}',
    '<subsection>': '\\begin{subsection}',
    '</subsection>': '\\end{subsection}',
    '<aligned>': '\\begin{aligned}',
    '</aligned>': '\\end{aligned}',
    '<alignat>': '\\begin{alignat}',
    '</alignat>': '\\end{alignat}',
    '<array>': '\\begin{array}',
    '</array>': '\\end{array}',

    // ===== Gemini-specific environment fixes =====
    '</equation}': '\\end{equation}',
    '</align}': '\\end{align}',
    '</figure}': '\\end{figure}',
    '</tikzpicture}': '\\end{tikzpicture}',
    '</itemize}': '\\end{itemize}',
    '</enumerate}': '\\end{enumerate}',
    '</revised_statement}': '</revised_statement>',
    '</scope}': '\\end{scope}',
    '</latex_document}': '</latex_document>',
    '</response}': '\\end{response}',
    '</referee}': '\\end{referee}',
    '</response>': '\\end{response}',
    '</referee>': '\\end{referee}',

    // ===== LaTeX document conversions =====
    '\\begin{latex_document}': '<latex_document>',
    '\\end{latex_document}': '</latex_document>',
    // the following logic is tricky, we might have to use some regex to match the tags

    // ===== Code block handling =====
    // Handle LaTeX inside Markdown code blocks
    '```latex\n\\documentclass[': '<latex_document>\n\\documentclass[',
    '<latex_document>\n```latex': '<latex_document>\n',
    'Here is the revised \\LaTeX document.\n\n```latex':
      'Here is the revised \\LaTeX document.\n\n<latex_document>',

    // ===== Scratchpad and document nesting =====
    // Fix scratchpad and latex_document tag handling
    '<scratchpad>\n<scratchpad>\n': '<scratchpad>\n',
    '<scratchpad>\n```latex\n': '<scratchpad>\n<latex_document>\n',
    '<scratchpad>```latex': '<scratchpad>\n<latex_document>',
    '```\n</scratchpad>\n</latex_document>': '</latex_document>',
    '</latex_document>\n```\n</latex_document>': '</latex_document>\n',
    '</latex_document>\n</latex_document>': '</latex_document>\n',
    '</latex_document>\n\n</latex_document>': '</latex_document>\n',

    // Fix nesting of XML/LaTeX code blocks
    '```latex\n<latex_document>\n': '\n<latex_document>\n',
    '<latex_document>\n<latex_document>': '<latex_document>',

    // ===== Document structure and nesting =====
    // Fix document closing and nesting issues
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

    // ===== Special cases =====
    // Fix document preamble and headers
    '{\\today}\\n\\n[Previous':
      '{\\today}\\n\\n\\begin{document}\\n\\makeheader[Previous', // Add document and header

    // ===== Empty attribute fixes =====
    '<document name="">': '<document name="unknown">',

    // ===== XML version tag removal =====
    '<?xml version="1.0" encoding="UTF-8"?>': '',

    // ===== LaTeX comment removal =====
    '% 1ST_UPDATED_LATEX_DOCUMENT HERE\n': '',
    '% 2ND_UPDATED_LATEX_DOCUMENT HERE\n': '',
    //
    '\\begin{<latex_document>\nalign': '\\begin{align',
    '\\begin{<latex_document>\nequation': '\\begin{equation',
    '\\begin{<latex_document>\nitemize': '\\begin{itemize',
    '\\begin{<latex_document>\nenumerate': '\\begin{enumerate}',
    '\\begin{<latex_document>\nfigure': '\\begin{figure}',
    '\\begin{<latex_document>\ntikzpicture': '\\begin{tikzpicture}',
    // '\\\n<latex_document>': '\\',

    '<xml:documents>': '<latex_documents>',
    '</xml:documents>': '</latex_documents>',

    // Gemini XML problem:
    '```xml\n': '',
    '</xml>': '',
  },
};

const SCRATCHPAD_XML_REPLACEMENTS: ReplacementCategory = {
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

const STYLE_REPLACEMENTS: ReplacementCategory = {
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
const PERSONAL_STYLE_REPLACEMENTS: ReplacementCategory = {
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
    ' \\, ': ' \\',
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
  },
};

// Maximum style replacements for LaTeX
const MAX_STYLE_REPLACEMENTS: ReplacementCategory = {
  name: 'max_style',
  description: 'Maximum style replacements for LaTeX commands and symbols',
  isRegex: false,
  patterns: {
    // Basic Math Operators
    '\\text{tr}': '\\tr',
    '\\text{Tr}': '\\Tr',
    '\\text{sign}': '\\sign',
    '\\text{argmin}': '\\argmin',
    '\\text{argmax}': '\\argmax',
    '\\text{sort}': '\\sort',
    '\\text{argsort}': '\\argsort',
    '\\text{Cat}': '\\Cat',
    '\\text{Bern}': '\\Bern',
    '\\text{Unif}': '\\Unif',
    '\\marhrm{const}': '\\const',
    '\\text{const}': '\\const',

    // Common Math Shortcuts
    '\\frac{1}{2}': '\\ha',
    '\\frac{1}{\\sqrt{2}}': '\\sha',
    '\\mathds{1}': '\\Id',
    '\\boldsymbol{0}': '\\bzero',
    '\\boldsymbol{1}': '\\bone',
    '\\mathrm{d}': '\\dd',

    // Greek Letters (Regular)
    '\\alpha': '\\al',
    '\\beta': '\\bt',
    '\\gamma': '\\ga',
    '\\delta': '\\de',
    '\\varepsilon': '\\eps',
    '\\theta': '\\ta',
    '\\Theta': '\\Ta',
    '\\kappa': '\\ka',
    '\\lambda': '\\la',
    '\\omega': '\\om',
    '\\Omega': '\\Om',
    '\\sigma': '\\sg',
    '\\Sigma': '\\Sig',
    '\\varphi': '\\vphi',
    '\\\\bet': '\\bet',
    '\\\\bze': '\\bze',

    // Greek Letters (Bold)
    '\\boldsymbol{\\alpha}': '\\bal',
    '\\boldsymbol{\\beta}': '\\bbt',
    '\\boldsymbol{\\chi}': '\\bch',
    '\\boldsymbol{\\epsilon}': '\\beps',
    '\\boldsymbol{\\eta}': '\\bet',
    '\\boldsymbol{\\gamma}': '\\bga',
    '\\boldsymbol{\\mu}': '\\bmu',
    '\\boldsymbol{\\nu}': '\\bnu',
    '\\boldsymbol{\\omega}': '\\bom',
    '\\boldsymbol{\\phi}': '\\bphi',
    '\\boldsymbol{\\pi}': '\\bpi',
    '\\boldsymbol{\\sigma}': '\\bsigma',
    '\\boldsymbol{\\theta}': '\\bta',
    '\\boldsymbol{\\varphi}': '\\bvphi',
    '\\boldsymbol{\\xi}': '\\bxi',
    '\\boldsymbol{\\zeta}': '\\bze',
    '\\boldsymbol{\\Sigma}': '\\bSig',
    '\\boldsymbol{\\lambda}': '\\bla',
    '\\boldsymbol{\\Gamma}': '\\bGa',
    '\\boldsymbol{\\Lambda}': '\\bLa',
    '\\bSigma': '\\bSig',

    // Hat Variables
    '\\hat{\\sigma}': '\\hsg',
    '\\hat{\\Sigma}': '\\hSig',
    '\\hat{\\pi}': '\\hpi',
    '\\hat{\\rho}': '\\hrho',
    '\\hat{H}': '\\hH',
    '\\hat{F}': '\\hF',
    '\\hat{P}': '\\hP',
    '\\hat{\\mathbf{n}}': '\\hbn',
    '\\hat{\\mathbf{v}}': '\\hbv',
    '\\hat{\\boldsymbol{\\zeta}}': '\\hbze',

    '\\frac12': '\\ha',

    // Mathcal Letters
    '\\mathcal{A}': '\\cA',
    '\\mathcal{B}': '\\cB',
    '\\mathcal{C}': '\\cC',
    '\\mathcal{D}': '\\cD',
    '\\mathcal{E}': '\\cE',
    '\\mathcal{F}': '\\cF',
    '\\mathcal{G}': '\\cG',
    '\\mathcal{H}': '\\cH',
    '\\mathcal{I}': '\\cI',
    '\\mathcal{J}': '\\cJ',
    '\\mathcal{K}': '\\cK',
    '\\mathcal{L}': '\\cL',
    '\\mathcal{M}': '\\cM',
    '\\mathcal{N}': '\\cN',
    '\\mathcal{O}': '\\cO',
    '\\mathcal{P}': '\\cP',
    '\\mathcal{Q}': '\\cQ',
    '\\mathcal{R}': '\\cR',
    '\\mathcal{S}': '\\cS',
    '\\mathcal{T}': '\\cT',
    '\\mathcal{U}': '\\cU',
    '\\mathcal{V}': '\\cV',
    '\\mathcal{W}': '\\cW',
    '\\mathcal{X}': '\\cX',
    '\\mathcal{Y}': '\\cY',
    '\\mathcal{Z}': '\\cZ',

    // Mathbb Letters
    '\\mathbb{C}': '\\eC',
    '\\mathbb{E}': '\\eE',
    '\\mathbb{I}': '\\eI',
    '\\mathbb{N}': '\\eN',
    '\\mathbb{P}': '\\eP',
    '\\mathbb{Q}': '\\eQ',
    '\\mathbb{R}': '\\eR',
    '\\mathbb{T}': '\\eT',
    '\\mathbb{V}': '\\eV',

    // Mathbf Letters (Lowercase)
    '\\mathbf{a}': '\\ba',
    '\\mathbf{b}': '\\bb',
    '\\mathbf{c}': '\\bc',
    '\\mathbf{e}': '\\be',
    '\\mathbf{f}': '\\bbf',
    '\\mathbf{g}': '\\bg',
    '\\mathbf{h}': '\\bh',
    '\\mathbf{j}': '\\bj',
    '\\mathbf{n}': '\\bn',
    '\\mathbf{p}': '\\bp',
    '\\mathbf{q}': '\\bq',
    '\\mathbf{r}': '\\br',
    '\\mathbf{s}': '\\bs',
    '\\mathbf{u}': '\\bu',
    '\\mathbf{v}': '\\bv',
    '\\mathbf{w}': '\\bw',
    '\\mathbf{x}': '\\bx',
    '\\mathbf{y}': '\\by',
    '\\mathbf{z}': '\\bz',

    // Mathbf Letters (Uppercase)
    '\\mathbf{A}': '\\bA',
    '\\mathbf{B}': '\\bB',
    '\\mathbf{C}': '\\bC',
    '\\mathbf{D}': '\\bD',
    '\\mathbf{E}': '\\bE',
    '\\mathbf{F}': '\\bF',
    '\\mathbf{G}': '\\bG',
    '\\mathbf{I}': '\\bI',
    '\\mathbf{J}': '\\bJ',
    '\\mathbf{K}': '\\bK',
    '\\mathbf{M}': '\\bM',
    '\\mathbf{Q}': '\\bQ',
    '\\mathbf{R}': '\\bR',
    '\\mathbf{U}': '\\bU',
    '\\mathbf{V}': '\\bV',
    '\\mathbf{W}': '\\bW',
    '\\mathbf{X}': '\\bX',
    '\\mathbf{Y}': '\\bY',
    '\\mathbf{Z}': '\\bZ',

    // Bar Variables
    '\\bar{\\rho}': '\\barrho',
    '\\bar{H}': '\\barH',
    '\\bar{S}': '\\barS',
    '\\bar{\\alpha}': '\\baral',
    '\\bar{\\mathbf{v}}': '\\barbv',

    // Tilde Variables
    '\\tilde{\\mathcal{H}}': '\\tcH',
    '\\tilde{\\mathcal{Q}}': '\\tcQ',
    '\\tilde{\\mathcal{S}}': '\\tcS',
    '\\tilde{\\mathcal{W}}': '\\tcW',
    '\\tilde{\\gamma}': '\\tga',
    '\\tilde{\\lambda}': '\\tla',
    '\\tilde{\\phi}': '\\tphi',
    '\\tilde{\\psi}': '\\tpsi',
    '\\tilde{\\rho}': '\\trho',
    '\\tilde{\\Sigma}': '\\tSig',
    '\\tilde{\\mu}': '\\tmu',
    '\\tilde{\\tau}': '\\ttau',
    '\\tilde{\\mathbf{a}}': '\\tba',
    '\\tilde{\\mathbf{x}}': '\\tbx',
    '\\tilde{\\mathbf{v}}': '\\tbv',
    '\\tilde{\\mathbf{p}}': '\\tbp',
    '\\tilde{\\mathbf{w}}': '\\tbw',
    '\\tilde{\\mathbf{z}}': '\\tbz',
    '\\tilde{\\mathbf{M}}': '\\tbM',
    '\\tilde{\\mathbf{T}}': '\\tbT',
    '\\tilde{\\mathbf{X}}': '\\tbX',
    '\\tilde{\\boldsymbol{\\zeta}}': '\\tbze',
    '\\tilde{\\boldsymbol{\\gamma}}': '\\tbga',
    '\\tilde{\\boldsymbol{\\lambda}}': '\\tbla',
    '\\tilde{\\boldsymbol{\\pi}}': '\\tbpi',
    '\\tilde{\\boldsymbol{\\xi}}': '\\tbxi',
    '\\tilde{\\boldsymbol{\\eta}}': '\\tbet',
    '\\tilde{\\boldsymbol{\\Gamma}}': '\\tbGa',
    '\\tilde{0}': '\\tzero',
    '\\tilde{1}': '\\tone',
    '\\tilde{t}': '\\tit',
    '\\tilde{f}': '\\tif',
    '\\tilde{x}': '\\tx',
    '\\tilde{z}': '\\tz',
    '\\tilde{p}': '\\tp',
    '\\tilde{q}': '\\tq',
    '\\tilde{B}': '\\tB',
    '\\tilde{F}': '\\tF',
    '\\tilde{J}': '\\tJ',
    '\\tilde{M}': '\\tM',
    '\\tilde{P}': '\\tP',
    '\\tilde{T}': '\\tT',
    '\\tilde{Z}': '\\tZ',

    // Vector Variables
    '\\vec{p}': '\\vp',
    '\\vec{q}': '\\vq',
    '\\vec{v}': '\\vv',
    '\\vec{x}': '\\vx',
    '\\vec{y}': '\\vy',

    // Physics and Statistical Mechanics
    'H^{\\text{eff}}': '\\effH',
    '\\mathcal{H}^{\\text{eff}}': '\\ceffH',
    'p^{\\text{eq}}': '\\peq',
    'q^{\\text{eq}}': '\\qeq',
    '\\rho^{\\text{eq}}': '\\rhoeq',
    '\\rho^{\\text{st}}': '\\rhost',

    // Arrows and Relations
    '\\rightarrow': '\\ra',
    '\\leftarrow': '\\lar',
    '\\leftrightarrow': '\\lra',
    '\\Leftarrow': '\\La',
    '\\Rightarrow': '\\Ra',
    '\\Leftrightarrow': '\\LRa',
    '\\not\\implies': '\\nimplies',

    // Calculus
    '\\partial': '\\der',
    '\\nabla': '\\na',
    '\\boldsymbol{\\nabla}': '\\bna',
    '\\text{div}': '\\bdiv',
    '\\frac{\\partial}{\\partial t}': '\\ddt',
    '\\frac{\\mathrm{d}}{\\mathrm{d} t}': '\\dddt',

    // Miscellaneous
    '\\nonumber': '\\nn',
    '\\dagger': '\\da',
    '\\backslash': '\\bksl',

    // Differential spacing preferences
    '\\dd s\\,': '\\dd s~',
    '\\dd\\bze\\,': '\\dd\\bze~',
    '\\dd\\bxi\\,': '\\dd\\bxi~',
    '\\dd\\beta\\,': '\\dd\\beta~',
    '\\dd\\tau\\,': '\\dd\\tau~',
    '\\dd\\t\\,': '\\dd\\t~',
    '\\dd\\bx\\,': '\\dd\\bx~',
    '\\dd\\bz\\,': '\\dd\\bz~',
    '\\dd\\bze_{\\tauf}\\,': '\\dd\\bze_{\\tauf}~',
    '\\dd x ': '\\dd x~ ',
    "\\dd x'": "\\dd x'~",
    '\\quad\\Ra': '~~~\\Ra',
    '\\Ra\,': '\\Ra~',
    '\\tau_f': '\\tauf',
    '\\frac{d\\tbx': '\\frac{\\dd\\tbx',
    '\\frac{d\\bx': '\\frac{\\dd\\bx',
    '\\frac{d}{d\\tau}': '\\frac{\\dd}{\\dd\\tau}',
    '\\frac{d}{d\\}': '\\frac{\\dd}{\\dd\\}',
    '{d t}': '{\\dd t}',
    '{dt}': '{\\dd t}',
    '{d x}': '{\\dd x}',
    '{dx}': '{\\dd x}',
    '\\frac{d}{d\\': '\\frac{\\dd}{\\dd\\',
    '{d\\tau}': '{\\dd\\tau}',
    '{d\\ttau}': '{\\dd\\ttau}',
    '{d\\bze}': '{\\dd\\bze}',
    '{d\\bxi}': '{\\dd\\bxi}',
    '{d\\beta}': '{\\dd\\beta}',
    '{d\\bx}': '{\\dd\\bx}',
    '{d\\bz}': '{\\dd\\bz}',
    ' d\\bz': ' d\\bz~',
    ' d\\bx': ' d\\bx~',
    ' d\\bze': ' d\\bze~',
    ' d\\bxi': ' d\\bxi~',
    ' d\\beta': ' d\\beta~',
    ' d\\tau': ' d\\tau~',
    ' d\\ttau': ' d\\ttau~',
    '\\int d\\': '\\int \\dd\\',

    '\\int \\dd \\bx \\': '\\int \\dd \\bx~ \\',
    '\\frac{dS}': '\\frac{\\dd S}',
    '\\\\ba': '\\ba',
    '\\\\bb': '\\bb',
    '\\\\bc': '\\bc',
    '\\\\be': '\\be',
    '\\\\bf': '\\bf',
    '\\\\bg': '\\bg',
    '\\\\bh': '\\bh',
    '\\\\bj': '\\bj',
    '\\\\bn': '\\bn',
    '\\\\bp': '\\bp',
    '\\\\bq': '\\bq',
    '\\\\br': '\\br',
    '\\\\bs': '\\bs',
    '\\\\bu': '\\bu',
    '\\\\bv': '\\bv',
    '\\\\bw': '\\bw',
    '\\\\bx': '\\bx',
    '\\\\by': '\\by',
    '\\\\bz': '\\bz',
    '\\\\bA': '\\bA',
    '\\\\bB': '\\bB',
    '\\\\bC': '\\bC',
    '\\\\bD': '\\bD',
    '\\\\bE': '\\bE',
    '\\\\bF': '\\bF',
    '\\\\bG': '\\bG',
    '\\\\bH': '\\bH',
    '\\\\bI': '\\bI',
    '\\\\bJ': '\\bJ',
    '\\\\bK': '\\bK',
    '\\\\bL': '\\bL',
    '\\\\bM': '\\bM',
    '\\\\bN': '\\bN',
    '\\\\bP': '\\bP',
    '\\\\bQ': '\\bQ',
    '\\\\bR': '\\bR',
    '\\\\bS': '\\bS',
    '\\\\bT': '\\bT',
    '\\\\bU': '\\bU',
    '\\\\bV': '\\bV',
    '\\\\bW': '\\bW',
    '\\\\bX': '\\bX',
    '\\\\bY': '\\bY',
    '\\\\bZ': '\\bZ',
    // equilibrium and steady state
    '{\\text{ss}}': '{\\text{st}}',
    '\\rho^{st}': '\\rhost',
    '\\rho^{eq}': '\\rhoeq',
    '\\rho^{\\text{ss}}': '\\rhost',
    '\\rho^{ss}': '\\rhost',
    '\\rho_{\\text{ss}}': '\\rhost',
    '\\rho_{ss}': '\\rhost',
    '\\ln': '\\log',
    '\\rhost^R': '\\rhost_R',
    '\\F_': 'F_',
    '\\F^': 'F^',
    '\\bepsilon': '\\beps',
    // '\\mathbf{I}': '\\bI',
    '{\\rm tot}': '\\text{tot}',
    '{\\rm eq}': '\\text{eq}',
    '{\\rm st}': '\\text{st}',
    '{\\rm na}': '\\text{na}',
    '\\G(': 'G(',
    '\\F(': 'F(',
  },
};

// ===== Regex replacements =====

// Parentheses sizing standardization
const PARENTHESES_REPLACEMENTS: ReplacementCategory = {
  name: 'parentheses',
  description: 'Standardize parentheses sizing using regex patterns',
  isRegex: true,
  flags: 'g',
  patterns: {
    // ===== Small delimiter normalization =====
    // Convert \big* delimiters to regular parentheses when content is simple
    '\\\\big\\(([^\\n]*?)\\\\big\\)': '($1)',
    '\\\\big\\[([^\\n]*?)\\\\big\\]': '[$1]',
    '\\\\bigl\\(([^\\n]*?)\\\\bigr\\)': '($1)',
    '\\\\bigl\\[([^\\n]*?)\\\\bigr\\]': '[$1]',

    // ===== Medium delimiter standardization =====
    // Convert \Big* delimiters to \left...\right format
    '\\\\Big\\(([^\\n]*?)\\\\Big\\)': '\\left($1\\right)',
    '\\\\Big\\[([^\\n]*?)\\\\Big\\]': '\\left[$1\\right]',
    '\\\\Big\\{([^\\n]*?)\\\\Big\\}': '\\left\\{$1\\right\\}',

    // ===== Bigl/Bigr delimiter standardization =====
    // Convert \Bigl...\Bigr to \left...\right format
    '\\\\Bigl\\(([^\\n]*?)\\\\Bigr\\)': '\\left($1\\right)',
    '\\\\Bigl\\[([^\\n]*?)\\\\Bigr\\]': '\\left[$1\\right]',
    '\\\\Bigl\\\\{([^\\n]*?)\\\\Bigr\\\\}': '\\left\\{$1\\right\\}',

    // ===== Large delimiter standardization =====
    // Convert \biggl...\biggr to \left...\right format
    '\\\\biggl\\(([^\\n]*?)\\\\biggr\\)': '\\left($1\\right)',
    '\\\\biggl\\[([^\\n]*?)\\\\biggr\\]': '\\left[$1\\right]',
    '\\\\biggl\\\\{([^\\n]*?)\\\\biggr\\\\}': '\\left\\{$1\\right\\}',

    // ===== Extra large delimiter standardization =====
    // Convert \Biggl...\Biggr to \left...\right format
    '\\\\Biggl\\(([^\\n]*?)\\\\Biggr\\)': '\\left($1\\right)',
    '\\\\Biggl\\[([^\\n]*?)\\\\Biggr\\]': '\\left[$1\\right]',
    '\\\\Biggl\\\\{([^\\n]*?)\\\\Biggr\\\\}': '\\left\\{$1\\right\\}',
  },
};

// TikZ picture fixes
// Using ECMAScript 2018 named capture groups (?<name>pattern)
// Similar to Python's (?P<name>pattern)
const TIKZ_REPLACEMENTS: ReplacementCategory = {
  name: 'tikz',
  description: 'Fixes for TikZ picture formatting and structure',
  isRegex: true,
  flags: 'gms',
  patterns: {
    '\\end{document}\\s*\\chapter': '\\chapter',
    '\\end{document}\\s*\\addcontentsline': '\\addcontentsline',
    '(?<indent>[\\t ]*)}\s*\\end{tikzpicture};\s*\\end{tikzpicture}':
      '${indent}\\end{tikzpicture}\n${indent}};\n${indent}\\end{tikzpicture}',
    '}(\\s*)\\end{tikzpicture};': '};$1\\end{tikzpicture}',
    '}(\\s*)\\end{tikzpicture}\\DIFaddendFL ;':
      '$1\\end{tikzpicture}};\DIFaddendFL',
  },
};

// LaTeX inline math formatting fixes
const INLINE_MATH_REPLACEMENTS: ReplacementCategory = {
  name: 'inlineMath',
  description: 'Fixes for LaTeX inline math formatting',
  isRegex: true,
  flags: 'g',
  patterns: {
    // ===== Convert \( \) to $ $ =====
    '\\\\\\(\\s*(.*?)\\s*\\\\\\)': '$$$1$',

    // ===== Remove spacing commands with arbitrary integers =====
    '\\[-?\\d+pt\\]': '', // Remove [Npt] spacing commands
    '\\[-?\\d+mm\\]': '', // Remove [Nmm] spacing commands
    '\\[-?\\d+ex\\]': '', // Remove [Nex] spacing commands
    '\\[0\\.-?\\d+mm\\]': '', // Remove [0.Nmm] spacing commands
    '\\[0\\.-?\\d+ex\\]': '', // Remove [0.Nex] spacing commands

    // ===== Remove horizontal and vertical spacing commands =====
    '\\\\hspace\\[-?\\d+pt\\]': '', // Remove \hspace[Npt] commands
    '\\\\hspace\\{-?\\d+mm\\}': '', // Remove \hspace{Nmm} commands
    '\\\\hspace\\{-?\\d+ex\\}': '', // Remove \hspace{Nex} commands
    '\\\\vspace\\{-?\\d+pt\\}': '', // Remove \vspace{Npt} commands
    '\\\\vspace\\{-?\\d+mm\\}': '', // Remove \vspace{Nmm} commands
    '\\\\vspace\\{-?\\d+ex\\}': '\n', // Replace \vspace{Nex} with newline
  },
};

/**
 * Get enabled replacement categories from VS Code settings
 */
function getEnabledReplacements(): string[] {
  return getConfig('latex.enabledReplacements', [
    'latex_spacing',
    'equations',
    'sections',
    'characters',
    'unicode',
    'environment_structure',
  ]);
}

/**
 * Get custom replacements from VS Code settings
 */
function getCustomReplacements(): { [key: string]: string } {
  return getConfig('latex.customReplacements', {});
}

/**
 * Get all non-regex replacements combined into a single category.
 */
export function getAllReplacements(): ReplacementCategory {
  const enabledCategories = getEnabledReplacements();
  const customReplacements = getCustomReplacements();

  let allPatterns: { [key: string]: string } = {};

  // Add replacements from enabled categories
  const categories = [
    // LaTeX Content Formatting
    EQUATION_REPLACEMENTS,
    SECTION_REPLACEMENTS,
    CHARACTER_REPLACEMENTS,
    UNICODE_REPLACEMENTS,
    LATEX_SPACING_REPLACEMENTS,
    // XML/Structural Formatting
    LATEX_XML_REPLACEMENTS,
    SCRATCHPAD_XML_REPLACEMENTS,
    STYLE_REPLACEMENTS,
    // Personal Style
    PERSONAL_STYLE_REPLACEMENTS,
    MAX_STYLE_REPLACEMENTS,
  ];

  categories.forEach((category) => {
    if (enabledCategories.includes(category.name) && !category.isRegex) {
      allPatterns = { ...allPatterns, ...category.patterns };
    }
  });

  // Add custom replacements (these take precedence over built-in ones)
  allPatterns = { ...allPatterns, ...customReplacements };

  return {
    name: 'all',
    description: 'Combined non-regex replacements',
    isRegex: false,
    patterns: allPatterns,
  };
}

/**
 * Get replacement patterns for a specific category.
 */
export function getReplacementsByCategory(
  categoryName: string,
): ReplacementCategory | undefined {
  const categories: { [key: string]: ReplacementCategory } = {
    equations: EQUATION_REPLACEMENTS,
    sections: SECTION_REPLACEMENTS,
    tikz: TIKZ_REPLACEMENTS,
    characters: CHARACTER_REPLACEMENTS,
    unicode: UNICODE_REPLACEMENTS,
    latex_xml: LATEX_XML_REPLACEMENTS,
    scratchpad_xml: SCRATCHPAD_XML_REPLACEMENTS,
    style: STYLE_REPLACEMENTS,
    inlineMath: INLINE_MATH_REPLACEMENTS,
    personal_style: PERSONAL_STYLE_REPLACEMENTS,
    latex_spacing: LATEX_SPACING_REPLACEMENTS,
    max_style: MAX_STYLE_REPLACEMENTS,
    // Add environment structure replacements
    environment_structure: ENVIRONMENT_STRUCTURE_REPLACEMENTS,
  };

  return categories[categoryName];
}

/**
 * Get all regex replacement categories in order of application.
 */
export function getAllReplacementsRegex(): ReplacementCategory[] {
  return [
    INLINE_MATH_REPLACEMENTS,
    TIKZ_REPLACEMENTS,
    PARENTHESES_REPLACEMENTS,
    ENVIRONMENT_STRUCTURE_REPLACEMENTS,
  ];
}

// maybe i can even do this for strings<some length...

/**
 * Apply replacements to text, handling both regex and non-regex patterns.
 */
export function applyReplacements(
  text: string,
  replacements: ReplacementCategory | ReplacementCategory[],
): string {
  // Convert single category to array for unified handling
  const replacementArray = Array.isArray(replacements)
    ? replacements
    : [replacements];

  // Process all replacements in order
  for (const category of replacementArray) {
    if (category.isRegex) {
      for (const [pattern, repl] of Object.entries(category.patterns)) {
        try {
          text = text.replace(
            new RegExp(pattern, category.flags),
            repl as string,
          );
        } catch (regexErr) {
          logger.error(
            CHANNEL,
            `Error with regex pattern "${pattern}": ${regexErr instanceof Error ? regexErr.message : String(regexErr)}`,
          );
        }
      }
    } else {
      for (const [old, newText] of Object.entries(category.patterns)) {
        text = text.replaceAll(old, newText as string);
      }
    }
  }
  return text;
}

// ===== LLM Output Specific Fixes =====

// Environment structure fixes
const ENVIRONMENT_STRUCTURE_REPLACEMENTS: ReplacementCategory = {
  name: 'environment_structure',
  description: 'Fixes for LaTeX environment structure and nesting issues',
  isRegex: true,
  flags: 'g',
  patterns: {
    // ===== Unclosed document environment fix =====
    // Ensures document environment is properly closed at end of file
    '(\\\\begin\\{document\\}[\\s\\S]*)(\\\\end\\{document)([^\\}]*)$':
      '$1\\\\end{document}',

    // ===== Environment tag bracket completion =====
    // Fixes environment tags with missing or incorrect closing brackets
    '\\\\end\\{([a-zA-Z\\*]+)([^\\}]*)': '\\\\end{$1}',
  },
};
