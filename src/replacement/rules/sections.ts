// Local imports - replacement
import {
  generateSectionSpacingFixes,
  SECTION_TYPES,
} from '@replacement/helpers';
import { ReplacementCategory } from '@replacement/types';

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
