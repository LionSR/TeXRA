// Local imports - replacement
import { ReplacementCategory, ReplacementFunction } from '../types';

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
  if (!replacement) {
    return match;
  }

  return `${leading}${replacement}${trailing}`;
};

export const EQUATION_MACRO_REPLACEMENTS: ReplacementCategory = {
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

export default EQUATION_MACRO_REPLACEMENTS;
