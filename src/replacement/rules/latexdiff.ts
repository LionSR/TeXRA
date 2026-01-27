// Local imports - replacement
import { ReplacementCategory } from '@replacement/types';

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
