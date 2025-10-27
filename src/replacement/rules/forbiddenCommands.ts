// Local imports - replacement
import { generateInvalidSectionEndingFixes, SECTION_TYPES } from '../helpers';
import { ReplacementCategory } from '../types';

export const LATEX_FORBIDDEN_REPLACEMENTS: ReplacementCategory = {
  name: 'latex_forbidden_commands',
  description:
    'Removes LaTeX commands that should never appear, such as section endings',
  isRegex: false,
  patterns: {
    ...generateInvalidSectionEndingFixes(SECTION_TYPES),
  },
};

export default LATEX_FORBIDDEN_REPLACEMENTS;
