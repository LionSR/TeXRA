// Local imports - replacement
import { ReplacementCategory } from '@replacement/types';

export const CHARACTER_REPLACEMENTS: ReplacementCategory = {
  name: 'characters',
  description: 'Fixes for special characters and diacritics',
  isRegex: false,
  patterns: {
    ansätze: 'ans{\\"a}tze',
    Rényi: "R{\\'e}nyi",
    Schrödinger: 'Schr{\\"o}dinger',
    'Schr{\\\\`o}dinger': 'Schr{\\"o}dinger',
    'Schr{\\\\`o}dingers': 'Schr{\\"o}dingers',
  },
};
