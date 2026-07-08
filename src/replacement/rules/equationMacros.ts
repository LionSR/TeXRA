// Local imports - replacement
import {
  RegexReplacementCategory,
  ReplacementFunction,
} from '@replacement/types';

const MACRO_TO_ENVIRONMENT: Record<string, string> = {
  be: '\\begin{equation}',
  ee: '\\end{equation}',
  bea: '\\begin{eqnarray}',
  eea: '\\end{eqnarray}',
  bse: '\\begin{subequations}',
  ese: '\\end{subequations}',
};

const expandEquationMacro: ReplacementFunction = (
  match,
  leading = '',
  macro = '',
  trailing = '',
) => {
  const replacement = MACRO_TO_ENVIRONMENT[macro];
  return replacement ? `${leading}${replacement}${trailing}` : match;
};

export const EQUATION_MACRO_REPLACEMENTS: RegexReplacementCategory = {
  name: 'equation_macros',
  description:
    'Expands short equation helpers like \\be into full environments',
  isRegex: true,
  flags: 'gm',
  patterns: {
    // Require macros to be on their own line so inline uses like "foo \\be bar"
    // remain untouched. We only support lowercase helpers here for backwards
    // compatibility with legacy documents that relied on these shorthands
    // (including the deprecated eqnarray environment).
    '^(\\s*)\\\\([a-z]+)(\\s*)$': expandEquationMacro,
  },
};
