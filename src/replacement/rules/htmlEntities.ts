// Local imports - replacement
import { ReplacementCategory } from '../types';

export const HTML_ENTITY_REPLACEMENTS: ReplacementCategory = {
  name: 'html_entities',
  description: 'Converts common HTML entities into LaTeX-safe equivalents',
  isRegex: false,
  patterns: {
    // Angle brackets often appear when XML tags are HTML-escaped
    '&lt;': '<',
    '&gt;': '>',

    // Ampersands should be escaped in LaTeX to avoid alignment issues
    '&amp;': '\\&',

    // Non-breaking spaces should remain non-breaking in LaTeX output
    '&nbsp;': '~',

    // Basic comparison operators frequently appear in HTML-escaped math
    '&le;': '\\leq',
    '&ge;': '\\geq',
  },
};

export default HTML_ENTITY_REPLACEMENTS;
