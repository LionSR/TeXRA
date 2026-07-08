// Local imports - replacement
import {
  generateInvalidSectionEndingFixes,
  SECTION_TYPES,
} from '@replacement/helpers';
import { NonRegexReplacementCategory } from '@replacement/types';

export const LATEX_FORBIDDEN_REPLACEMENTS: NonRegexReplacementCategory = {
  name: 'latex_forbidden_commands',
  description:
    'Removes LaTeX commands that should never appear, such as section endings',
  isRegex: false,
  patterns: generateInvalidSectionEndingFixes(SECTION_TYPES),
};
