// Local imports - replacement
import { ReplacementCategory } from '../types';

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

export default PERSONAL_STYLE_REPLACEMENTS;
