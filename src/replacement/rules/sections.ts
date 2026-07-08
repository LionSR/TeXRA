// Local imports - replacement
import {
  generateSectionSpacingFixes,
  SECTION_TYPES,
} from '@replacement/helpers';
import { NonRegexReplacementCategory } from '@replacement/types';

export const SECTION_REPLACEMENTS: NonRegexReplacementCategory = {
  name: 'sections',
  description: 'Fixes for section spacing in LaTeX documents',
  isRegex: false,
  // Examples:
  // \end{align}\n\section -> \end{align}\n\n\n\section
  // \end{equation}\n\paragraph -> \end{equation}\n\n\n\paragraph
  patterns: generateSectionSpacingFixes(
    ['align', 'equation'],
    SECTION_TYPES.slice(0, 3),
  ),
};
