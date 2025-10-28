// Local imports - replacement
import { ReplacementCategory } from '../types';

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
    ' \\,=\\, ': ' = ',
    ' \\,:=\\, ': ' := ',
    ' \\=\\ ': ' = ',
    ' \\ :=\\ ': ' := ',
    ' \\,\\equiv\\, ': ' \\equiv ',
    ' \\equiv\\ ': ' \\equiv ',
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
    '\!\\left\!': ' \\left ',
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

    // ===== O1/O3 model specific fixes =====
    '=    \\': '= \\',
    ' rho_': '  \\rho_',
    ' rho^': '  \\rho^',
    ' rho\\': '  \\rho\\',

    // ===== Math limits formatting =====
    '\\sum\\limits_': '\\sum_',
  },
};

export default LATEX_SPACING_REPLACEMENTS;
